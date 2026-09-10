import { Effect } from "effect";

import { operationErrors } from "../../core/errors.ts";
import { claudeTmuxName } from "../../core/harness/claude/harness.ts";
import { claudeInjectSelftest, inspectorSocketExists, inspectorSocketPath } from "../../core/harness/claude/inject.ts";
import { wtSessionUuid } from "../../core/harness/claude/jsonl.ts";
import { claudeSessions } from "../../core/harness/claude/sessions.ts";
import { SESSION_SLOTS } from "../../core/session-slots.ts";
import { dirSlug } from "../../core/stage.ts";
import { listSessions } from "../../core/tmux.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { verifyStepsHeadline, workAge } from "../../core/work-status.ts";
import { isMergedRemoval, readWtState, verificationOwedAtRemoval } from "../../core/wtstate.ts";
import type { Worktree } from "../../core/types.ts";
import { hasHelpFlag } from "../args.ts";
import { dim, green, red, yellow } from "../colors.ts";

const USAGE = `usage: wt claude send <target> [text...] deprecated alias for wt agent send
       wt claude ls [--json]             list live claude sessions
       wt claude selftest [<slug>]       check that prompt injection still works
       wt claude stop <slug>             stop the worktree's primary claude session

\`send\` is a compatibility alias for \`wt agent send\`. It does not force
Claude: wt routes to the target's active harness, or its Shift+Tab primary
when none is active. Use \`wt agent send\` in new scripts and instructions.

Messages are stamped with the sending agent (\`[<slug>] …\`) when sent
from inside a wt harness session. Nothing to pass; nothing to remember.

The neutral \`wt agent ls [--json]\` inventory lists every addressable
worktree and special session. This command's \`ls\`, \`selftest\`, and
\`stop\` subcommands remain Claude-specific diagnostics and control.

\`ls --json\` adds the stable session id, pid, cwd, tmux identity,
status, what it is blocked on, last activity, and \`transport\` —
"inspector" for a session wt can submit into directly, "terminal" for
one that has to be typed at.

With no [text...], stdin is read instead (heredoc-friendly for
multiline prompts). <slug> also accepts a branch name
(michael/eng-NNNN-...).`;

/** Claude-only diagnostics/control use the same authoritative slot paths as the TUI. */
const SLOT_TARGETS = Object.fromEntries(
  SESSION_SLOTS.map((slot) => [
    slot.slug,
    { cwd: slot.path, managedName: slot.claudeName },
  ]),
) as Record<string, { cwd: string; managedName: string | null }>;

const io = operationErrors("wt claude");

export function neutralSendArgs(slugOrBranch: string, textArgs: string[]): string[] {
  return ["send", slugOrBranch, ...textArgs];
}

/** Resolve a slug-or-branch argument to a live (non-main) worktree. */
function findWorktree(slugOrBranch: string) {
  const slug = slugOrBranch.includes("/") ? dirSlug(slugOrBranch) : slugOrBranch;
  return listWorktrees().pipe(
    Effect.map((wts): Worktree | null => wts.filter((w) => !w.isMain).find((w) => w.slug === slug) ?? null),
  );
}

/**
 * Error path for an unresolvable `send`/`kill` target. A slug in the
 * removed history gets the real answer ("archived on merge (#N, 2h
 * ago)") instead of a bare "no worktree" — the asker is usually the
 * manager wondering where a row went. Otherwise name the addressable
 * set used by the Claude-specific diagnostic/control commands.
 */
function explainMissingTarget(slugOrBranch: string): void {
  const slug = slugOrBranch.includes("/") ? dirSlug(slugOrBranch) : slugOrBranch;
  const removed = readWtState().removed.find((e) => e.slug === slug || e.branch === slugOrBranch);
  if (removed) {
    const age = workAge(removed.removedAt);
    const ageSuffix = age ? `, ${age} ago` : "";
    const detail = isMergedRemoval(removed)
      ? `archived on merge (${removed.prNumber !== undefined ? `#${removed.prNumber}` : "PR merged"}${ageSuffix})`
      : `worktree removed${age ? ` ${age} ago` : ""}`;
    console.error(red(`no live worktree: ${slug} — ${detail}`));
    // The asker is usually a coordinator wondering where a row went,
    // and the next question is always whether anything was left owing.
    // Saying nothing here is what sent one to file an issue preserving
    // a check that had already been run and recorded.
    if (verificationOwedAtRemoval(removed)) {
      console.error(yellow(`  UNVERIFIED — still owed: ${verifyStepsHeadline(removed.work!.verifyAfterMerge!)}`));
    } else if (removed.work) {
      const note = removed.work.note ? `: ${removed.work.note}` : "";
      console.error(dim(`  last status: ${removed.work.state}${note}`));
    }
    return;
  }
  console.error(red(`no worktree: ${slugOrBranch}`));
  console.error(dim(`addressable: worktree slugs (see wt ls) plus ${Object.keys(SLOT_TARGETS).join(", ")}`));
}

const send = Effect.fn("wt claude send compatibility")(function* (
  slugOrBranch: string,
  textArgs: string[],
) {
  console.error(dim("`wt claude send` is deprecated; routing through `wt agent send`"));
  const agent = yield* io.promise("load neutral agent command", () => import("./agent.ts"));
  return yield* agent.run(neutralSendArgs(slugOrBranch, textArgs));
});

/**
 * `wt claude selftest` — does prompt injection still work?
 *
 * The structural anchors the injector uses live in Claude Code's own
 * React tree, so a Claude Code update is the thing that breaks them.
 * This is the check that says so out loud, before a fleet-wide nudge
 * quietly degrades to typing into panes. `wt doctor` runs it too.
 */
const selftest = Effect.fn("wt claude selftest")(function* (slugOrBranch: string | undefined) {
  const sessions = yield* listSessions();
  const wanted = slugOrBranch ? (slugOrBranch.includes("/") ? dirSlug(slugOrBranch) : slugOrBranch) : null;
  const entries = [...sessions.claude]
    .filter((e) => wanted === null || e.slug === wanted)
    .sort((a, b) => a.slug.localeCompare(b.slug));
  if (entries.length === 0) {
    console.log(dim(wanted ? `no live claude session for ${wanted}` : "no live claude sessions"));
    return wanted ? 1 : 0;
  }
  // Concurrently: the probes are independent, and each is bounded by a
  // 12s attempt timeout, so one wedged session would otherwise delay
  // every session queued behind it.
  const probes = yield* Effect.all(
    entries.map((entry) => {
      const tmuxSession = claudeTmuxName(entry.slug, entry.name);
      return claudeInjectSelftest(tmuxSession).pipe(
        Effect.map((probe) => ({ tmuxSession, probe })),
      );
    }),
    { concurrency: "unbounded" },
  );
  let bad = 0;
  for (const { tmuxSession, probe } of probes) {
    if (probe.ok) {
      console.log(
        `${green("✓")} ${tmuxSession} ${dim(probe.foundCaret ? "prompt + input + caret" : "prompt + input (no caret restore)")}`,
      );
      continue;
    }
    bad += 1;
    console.log(`${red("✗")} ${tmuxSession} ${dim(`${probe.kind}: ${probe.reason}`)}`);
  }
  if (bad > 0) {
    console.error(
      dim(
        "» messages to the failing sessions are typed into their panes instead.\n" +
          "» `absent`/`stale`: restart the session from wt. `not-ready`: it may be on a\n" +
          "» dialog — if every session fails, Claude Code moved the injector's anchors\n" +
          "» (see src/core/harness/claude/inject/page-routine.ts).",
      ),
    );
  }
  return bad > 0 ? 1 : 0;
});

const ls = Effect.fn("wt claude ls")(function* (json: boolean) {
  const sessions = yield* listSessions();
  const entries = [...sessions.claude].sort((a, b) => a.slug.localeCompare(b.slug));
  if (json) {
    const wts = (yield* listWorktrees()).filter((w) => !w.isMain);
    const cwdBySlug = new Map<string, string>(wts.map((w) => [w.slug, w.path]));
    for (const [slug, t] of Object.entries(SLOT_TARGETS)) {
      if (!cwdBySlug.has(slug)) cwdBySlug.set(slug, t.cwd);
    }
    const nativeById = new Map(claudeSessions.list().map((session) => [session.sessionId, session]));
    const payload = entries.map((e) => {
      const cwd = cwdBySlug.get(e.slug);
      const native = cwd ? (nativeById.get(wtSessionUuid(cwd, e.name)) ?? null) : null;
      const tmuxSession = claudeTmuxName(e.slug, e.name);
      // `transport` is the actionable field: "terminal" means this
      // session has no inspector socket, so messages to it are typed
      // into its pane — worth knowing before wondering why a draft
      // vanished or a slash command didn't run.
      const injectable = inspectorSocketExists(tmuxSession);
      return {
        slug: e.slug,
        name: e.name,
        session_id: native?.sessionId ?? null,
        pid: native?.pid ?? null,
        cwd: cwd ?? null,
        socket_path: injectable ? inspectorSocketPath(tmuxSession) : null,
        transport: injectable ? "inspector" : "terminal",
        tmux_session: tmuxSession,
        alive: true,
        status: native?.status ?? null,
        busy: native ? native.status === "busy" || native.status === "shell" : null,
        waiting_for: native?.waitingFor ?? null,
        last_activity: native && native.updatedAt > 0 ? new Date(native.updatedAt).toISOString() : null,
      };
    });
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }
  if (entries.length === 0) {
    console.log(dim("no live claude sessions"));
    return 0;
  }
  for (const entry of entries) {
    console.log(entry.name === null ? entry.slug : `${entry.slug}${dim(` ~${entry.name}`)}`);
  }
  return 0;
});

const stop = Effect.fn("wt claude stop")(function* (slugOrBranch: string) {
  const slot = SLOT_TARGETS[slugOrBranch] ?? null;
  const wt = slot ? null : yield* findWorktree(slugOrBranch);
  if (!slot && !wt) {
    explainMissingTarget(slugOrBranch);
    return 1;
  }
  const slug = slot ? slugOrBranch : wt!.slug;
  yield* claudeSessions.stop({
    slug,
    cwd: slot ? slot.cwd : wt!.path,
    managedName: slot?.managedName ?? null,
  });
  console.log(green(`✓ stopped ${slug}'s claude session`));
  return 0;
});

export const run = Effect.fn("wt claude")(function* (argv: string[]) {
  // Only the subcommand/slug slot is checked for --help, never the
  // `send` free-text tail — a message that happens to contain the
  // literal word "--help" must still get sent, not swallowed as a
  // usage request.
  const [first, ...rest] = argv;
  if (!first || hasHelpFlag([first])) {
    console.log(USAGE);
    return first ? 0 : 2;
  }
  if (first === "send") {
    const [slug, ...text] = rest;
    if (!slug || hasHelpFlag([slug])) {
      console.log(USAGE);
      return slug ? 0 : 2;
    }
    return yield* send(slug, text);
  }
  if (first === "ls") {
    const unknown = rest.find((arg) => arg !== "--json");
    if (unknown || rest.filter((arg) => arg === "--json").length > 1) {
      console.error(red(`unknown argument for claude ls: ${unknown ?? "--json"}`));
      return 2;
    }
    return yield* ls(rest.includes("--json"));
  }
  if (first === "selftest") {
    if (rest.length > 1) {
      console.error(red(`unexpected argument: ${rest[1]}`));
      return 2;
    }
    return yield* selftest(rest[0]);
  }
  if (first === "stop" || first === "kill") {
    const [slug] = rest;
    if (slug && hasHelpFlag([slug])) {
      console.log(USAGE);
      return 0;
    }
    if (!slug || rest.length > 1) {
      console.error(red(!slug ? "missing claude session slug" : `unexpected argument: ${rest[1]}`));
      console.error(USAGE);
      return 2;
    }
    return yield* stop(slug);
  }
  console.error(red(USAGE));
  return 2;
});
