/**
 * The one place a prompt is handed to a live harness conversation.
 *
 * For Claude there are two transports, tried in this order:
 *
 *  1. **Prompt injection** through the session's inspector socket
 *     (`claude/inject.ts`). The message is submitted at that session's
 *     own prompt, in-process, so it arrives as an ordinary user turn —
 *     stamped `origin:{kind:"human"}` in the transcript, with none of
 *     the peer-message framing that makes a receiving agent stop and
 *     ask the human about a flow the human already approved. Slash
 *     commands run. Drafts survive. A busy target queues it.
 *  2. **Terminal input** (`tmux/inject.ts`): bracketed paste + submit
 *     keys. Strictly worse — it can't preserve a draft, and the pane is
 *     shared with whoever is attached — but it works against sessions
 *     wt didn't launch, and against a session whose socket died with a
 *     restart. It is the automatic fallback, never a choice.
 *
 * Every fallback raises an attention line naming which failure it was,
 * because the remedies differ: a stale socket wants that session
 * restarted, a failed selftest wants the injector's anchors re-derived
 * against the new Claude Code.
 *
 * TWO FAILURES MUST NOT FALL BACK, and they are the reason the ladder
 * is a ladder rather than a try/catch:
 *
 *  - `blocked` — the session is waiting on a human (a permission
 *    prompt). Typing there presses the submit key on somebody's dialog,
 *    answering it on their behalf. Checked before the attempt AND
 *    re-checked throughout the readiness wait, because a dialog that
 *    appears mid-wait is indistinguishable, to the probe, from a prompt
 *    that hasn't mounted yet.
 *  - `submitted-unknown` — the submit reached the target and we stopped
 *    waiting for its answer. Closing our socket doesn't cancel it, so
 *    typing the same text would double-submit. We confirm against the
 *    transcript instead.
 *
 * Other harnesses have only terminal input and always take path 2.
 */
import { withAsyncFileLock } from "../locks.ts";
import { createLogger } from "../logger.ts";
import { pollUntil } from "../poll.ts";
import {
  injectClaudeFallback,
  injectIntoSession,
  type InjectResult,
} from "../tmux/inject.ts";
import {
  deliverClaudeMessage,
  inspectorEnabled,
  type InjectFailureKind,
} from "./claude/inject.ts";
import { claudeTmuxName } from "./claude/harness.ts";
import { injectedPromptLanded } from "./claude/jsonl.ts";
import { claudeSessions } from "./claude/sessions.ts";
import type { RegistryStatus } from "./claude/registry.ts";
import type { HarnessId } from "./types.ts";

export type MessageTransport = "inspector" | "terminal";

/**
 * Why a message went out over the terminal instead of the injector.
 *
 * Two of these mean nothing is wrong: `disabled` is the sender's own
 * switch, and `unsupported` is a harness that never had an injector.
 * The rest are real degradations with genuinely different remedies.
 * The distinction rides on the RESULT rather than only in the log
 * because the caller is what a human or an agent actually reads.
 */
export type FallbackCause =
  | { kind: "disabled" }
  | { kind: "unsupported"; harnessId: HarnessId }
  | { kind: InjectFailureKind; reason: string };

type SessionMessageOk = {
  /** The session wasn't running and was started for this message. */
  coldStarted: boolean;
  /**
   * Did the prompt reach the conversation? `null` = nothing durable
   * can witness it (a slash command leaves no prompt entry), so
   * delivery is UNKNOWN — report it that way, never as success.
   */
  delivered: boolean | null;
  /** A first attempt was swallowed and the prompt was sent again. */
  resent: boolean;
};

export type SessionMessageResult =
  | (SessionMessageOk & { ok: true; transport: "inspector"; fallback?: never })
  | (SessionMessageOk & { ok: true; transport: "terminal"; fallback: FallbackCause })
  | { ok: false; reason: string };

export type SessionMessageTarget = {
  slug: string;
  cwd: string;
  harnessId: HarnessId;
  managedName?: string | null;
  text: string;
};

/** How long to wait for a session's prompt UI to become injectable. */
const READY_WARM_MS = 4_000;
const READY_COLD_MS = 20_000;
/** Transcript-confirmation window for an injected prompt. */
const CONFIRM_MS = 8_000;
const CONFIRM_POLL_MS = 250;

/**
 * The sending agent's identity, from the environment wt stamps on every
 * harness session (`WT_AGENT`, see `tmux/inner-process.ts`).
 *
 * This replaces the convention of telling agents to hand-prefix their
 * messages: a rule an agent has to remember is a rule that gets
 * forgotten, and an unattributed fleet message is nearly useless to the
 * manager. Absent outside a wt harness session — the TUI and a human's
 * shell send unsigned, which is correct: they aren't agents.
 *
 * It is an attribution aid, not a credential: anything running inside a
 * session can set it. Everything here already trusts the session.
 */
export function senderTag(): string | null {
  const agent = (process.env.WT_AGENT ?? "").trim();
  return agent.length > 0 ? agent : null;
}

/**
 * Whether a payload is a slash command rather than a message — i.e.
 * whether it only means anything if the harness *executes* it.
 *
 * Anchored and shaped, not a bare `startsWith("/")`: a command name is
 * lowercase and unbroken, and must be the whole first token. That is
 * what keeps a message opening with an absolute path out of the command
 * path — `/Users/…` fails the lowercase rule and `/tmp/foo` fails the
 * token boundary, while `/compact` and `/compact <args>` match.
 */
function isSlashCommand(text: string): boolean {
  return /^\/[a-z][a-z0-9_-]*(\s|$)/.test(text.trimStart());
}

/**
 * Prefix `text` with the sending agent's name.
 *
 * Two things are deliberately left unstamped. A payload that already
 * opens with a bracketed tag (`[re: <slug>]` briefings, anything a
 * caller attributed itself) keeps its own framing instead of collecting
 * a second bracket. And a slash command is left exactly as it is: the
 * injector submits it at the prompt, where it RUNS — but only while the
 * command is the first token, so a sender tag would quietly turn
 * `/compact` back into a sentence about compaction, which is the
 * failure this whole transport was meant to end.
 */
export function stampSender(text: string): string {
  const tag = senderTag();
  if (!tag) return text;
  if (/^\s*\[/.test(text)) return text;
  if (isSlashCommand(text)) return text;
  return `[${tag}] ${text}`;
}

type SessionSnapshot = { status: RegistryStatus; waitingFor: string | null };

type Dependencies = {
  inspectorEnabled(): boolean;
  ensureInfo(target: { slug: string; cwd: string; managedName: string | null }): Promise<{
    session: SessionSnapshot;
    coldStarted: boolean;
  }>;
  /** Fresh status, re-read during the readiness wait. */
  statusOf(target: { slug: string; cwd: string; managedName: string | null }): SessionSnapshot | null;
  deliver: typeof deliverClaudeMessage;
  terminal(target: SessionMessageTarget): Promise<InjectResult>;
  landed(cwd: string, managedName: string | null, text: string, sinceMs: number): boolean;
  warn(slug: string, message: string): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  lock<T>(key: string, body: () => Promise<T>): Promise<T>;
};

const defaults: Dependencies = {
  inspectorEnabled,
  ensureInfo: (target) => claudeSessions.ensureInfo(target),
  statusOf: (target) => claudeSessions.find(target),
  deliver: deliverClaudeMessage,
  terminal: (target) =>
    target.harnessId === "claude"
      ? injectClaudeFallback(target)
      : injectIntoSession({ ...target, harnessId: target.harnessId }),
  landed: injectedPromptLanded,
  warn: (slug, message) => createLogger(slug).attention.warn(message),
  now: Date.now,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  lock: withAsyncFileLock,
};

/**
 * One line naming why direct delivery didn't happen and what, if
 * anything, brings it back.
 *
 * DELIBERATELY NOT IMPERATIVE. Whoever reads this is usually not the
 * target's owner — an agent messaging a peer, the manager fanning a
 * briefing out — and the target is usually mid-turn. "Restart it from
 * wt to fix" reads as an instruction to kill a live conversation, for
 * a message that was just delivered successfully by typing. So each
 * line states the CONDITION under which the injector comes back and
 * leaves the restart to whoever owns that session, who will do it on
 * their own schedule anyway.
 *
 * Nothing here is urgent by construction: the message got through, or
 * the caller was told it didn't.
 */
export function fallbackAdvice(cause: FallbackCause): string {
  switch (cause.kind) {
    case "disabled":
      return "direct delivery is switched off here (WT_INSPECT=off)";
    case "unsupported":
      return `${cause.harnessId} has no prompt injector, so typing is its only transport`;
    case "absent":
      return "it has no inspector socket (started outside wt, or before this version); direct delivery resumes the next time that session is started from wt";
    case "stale":
      return "its inspector socket died with a restart; direct delivery resumes the next time that session is started from wt";
    case "not-ready":
      return "its prompt UI wasn't reachable in time — if this keeps happening, Claude Code moved the injector's anchors (wt claude selftest)";
    case "blocked":
      return "it is waiting on a human";
    case "submitted-unknown":
      return "the submit was sent but went unacknowledged";
    case "failed":
      return "the injector reached it but the submit failed";
  }
}

export function createSessionMessenger(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { ...defaults, ...overrides };
  /** One attention line per session per failure kind per process. */
  const warned = new Set<string>();

  function warnFallback(slug: string, tmuxName: string, cause: FallbackCause): void {
    const key = `${tmuxName}\0${cause.kind}`;
    if (warned.has(key)) return;
    warned.add(key);
    const detail = "reason" in cause ? ` (${cause.reason})` : "";
    deps.warn(
      slug,
      `${tmuxName}: fell back to typing into the pane — ${fallbackAdvice(cause)}${detail}`,
    );
  }

  function blockedReason(snapshot: SessionSnapshot | null, tmuxName: string): string | null {
    if (!snapshot || snapshot.status !== "waiting") return null;
    return `${tmuxName} is waiting on a human${
      snapshot.waitingFor ? ` (${snapshot.waitingFor})` : ""
    } — answer it first, then resend`;
  }

  /**
   * Did the injected prompt reach the conversation?
   *
   * A prompt submitted while the target is mid-turn QUEUES — exactly as
   * typing would — and won't appear in the transcript until that turn
   * ends, which can be many minutes. So a session that wasn't idle at
   * submit time and hasn't recorded the prompt yet is reported as
   * delivered: the submit was accepted, and the alternative is telling
   * the caller a queued message was lost. Only an IDLE session that
   * never records it really did swallow it.
   */
  async function confirmInjected(opts: {
    cwd: string;
    managedName: string | null;
    text: string;
    sinceMs: number;
    idleAtSubmit: boolean;
  }): Promise<boolean> {
    const landed = await pollUntil({
      check: () => deps.landed(opts.cwd, opts.managedName, opts.text, opts.sinceMs),
      budgetMs: CONFIRM_MS,
      intervalMs: CONFIRM_POLL_MS,
      now: deps.now,
      sleep: deps.sleep,
    });
    return landed || !opts.idleAtSubmit;
  }

  async function sendToClaude(target: SessionMessageTarget): Promise<SessionMessageResult> {
    const { slug, cwd, text } = target;
    const managedName = target.managedName ?? null;
    const tmuxName = claudeTmuxName(slug, managedName);
    const identity = { slug, cwd, managedName };
    const typeIt = async (cause: FallbackCause): Promise<SessionMessageResult> => {
      const res = await deps.terminal({ ...target, managedName, text });
      return res.ok ? { ...res, transport: "terminal", fallback: cause } : res;
    };

    if (!deps.inspectorEnabled()) return await typeIt({ kind: "disabled" });

    let coldStarted = false;
    let idleAtSubmit = false;
    try {
      // Cold-start under wt, which is what stamps BUN_INSPECT — a
      // session wt starts is injectable; one started any other way is
      // not.
      const ensured = await deps.ensureInfo(identity);
      coldStarted = ensured.coldStarted;
      idleAtSubmit = ensured.session.status === "idle";
      const blocked = blockedReason(ensured.session, tmuxName);
      if (blocked) return { ok: false, reason: blocked };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }

    const sinceMs = deps.now();
    const delivery = await deps.deliver(tmuxName, text, {
      readyBudgetMs: coldStarted ? READY_COLD_MS : READY_WARM_MS,
      abortIfBlocked: () => blockedReason(deps.statusOf(identity), tmuxName),
    });

    if (delivery.ok) {
      // A slash command is recorded in the transcript as an EXPANDED
      // command entry, not as the text that was submitted, so scanning
      // for the payload can only ever come back empty — `/context` runs
      // perfectly and confirms as lost. Unknown is the honest answer.
      const delivered = isSlashCommand(text)
        ? null
        : await confirmInjected({ cwd, managedName, text, sinceMs, idleAtSubmit });
      return { ok: true, coldStarted, delivered, resent: false, transport: "inspector" };
    }

    if (delivery.kind === "blocked") return { ok: false, reason: delivery.reason };

    if (delivery.kind === "submitted-unknown") {
      // Retyping could double-submit, so ask the transcript instead.
      const landed = await confirmInjected({
        cwd,
        managedName,
        text,
        sinceMs,
        idleAtSubmit: true,
      });
      if (landed) {
        return { ok: true, coldStarted, delivered: true, resent: false, transport: "inspector" };
      }
      return {
        ok: false,
        reason: `${tmuxName} did not acknowledge the submit and the message is not in its transcript — resend only if it is still missing (a duplicate is possible)`,
      };
    }

    const cause: FallbackCause = { kind: delivery.kind, reason: delivery.reason };
    warnFallback(slug, tmuxName, cause);
    return await typeIt(cause);
  }

  /**
   * Deliver a prompt to a live harness conversation, cold-starting its
   * tmux host when needed.
   */
  return async function send(target: SessionMessageTarget): Promise<SessionMessageResult> {
    const text = stampSender(target.text);
    if (!text.trim()) return { ok: false, reason: "message is empty" };
    if (target.harnessId !== "claude") {
      const res = await deps.terminal({ ...target, text });
      return res.ok
        ? {
            ...res,
            transport: "terminal",
            fallback: { kind: "unsupported", harnessId: target.harnessId },
          }
        : res;
    }
    // Serialize per target conversation. The manager slot is a genuine
    // multi-writer singleton (TUI automations, `wt manager send` from N
    // worktree agents, `[[actions]]` with target="manager"), often from
    // different processes — and two overlapping injections each capture
    // the target's draft, submit, and re-assert their own snapshot on a
    // timer, so the later timer wins and stomps the other's draft. The
    // terminal transport has always taken a lock here for the same
    // reason; the key is distinct from the ones `ensureInfo` and the
    // terminal path take, and is always acquired before them.
    const tmuxName = claudeTmuxName(target.slug, target.managedName ?? null);
    return await deps.lock(`__claude_send__${tmuxName}`, () => sendToClaude({ ...target, text }));
  };
}

export const sendSessionMessage = createSessionMessenger();

export type { InjectResult };
