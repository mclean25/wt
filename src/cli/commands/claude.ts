import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { config } from "../../core/config.ts";
import { claudeTmuxName } from "../../core/harness/claude/harness.ts";
import {
  claudeInjectSelftest,
  inspectorSocketExists,
  inspectorSocketPath,
} from "../../core/harness/claude/inject.ts";
import { wtSessionUuid } from "../../core/harness/claude/jsonl.ts";
import { claudeSessions } from "../../core/harness/claude/sessions.ts";
import { fallbackAdvice, sendSessionMessage } from "../../core/harness/session-messaging.ts";
import {
  ensureManagerClaudeName,
  MANAGER_CLAUDE_NAME,
  MANAGER_SLUG,
} from "../../core/manager.ts";
import { dirSlug } from "../../core/stage.ts";
import {
  listSessions,
  WT_SOURCE_SLUG,
} from "../../core/tmux.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { verifyStepsHeadline, workAge } from "../../core/work-status.ts";
import {
  isMergedRemoval,
  readWtState,
  verificationOwedAtRemoval,
} from "../../core/wtstate.ts";
import type { Worktree } from "../../core/types.ts";
import { hasHelpFlag } from "../args.ts";
import { dim, green, red, yellow } from "../colors.ts";

const USAGE = `usage: wt claude send <slug> [text...]   send a prompt to the worktree's claude session
       wt claude ls [--json]             list live claude sessions
       wt claude selftest [<slug>]       check that prompt injection still works
       wt claude stop <slug>             stop the worktree's primary claude session

\`send\` upserts the worktree's PRIMARY Claude Code session: starts it
detached in the wt tmux server when absent (waiting for claude to
finish booting), then submits the prompt at that session's own prompt,
in-process. It lands as an ordinary user turn in the live conversation
with its existing context — not a headless \`claude -p\` run, and not
peer-framed text the receiver has to decide whether to act on. A slash
command runs. A draft in the session's input box is preserved. A busy
session queues it. Fire-and-forget: there is no completion signal;
attach via the TUI (F12) to watch.

Messages are stamped with the sending agent (\`[<slug>] …\`) when sent
from inside a wt harness session. Nothing to pass; nothing to remember.

Besides worktree slugs, \`send\` accepts the repo-level session slugs
that \`wt claude ls\` lists: wt (the wt source repo), main (the main
clone), dotfiles, and manager (the fleet coordinator — same session
as \`wt manager send\`).

\`ls --json\` adds the stable session id, pid, cwd, tmux identity,
status, what it is blocked on, last activity, and \`transport\` —
"inspector" for a session wt can submit into directly, "terminal" for
one that has to be typed at.

With no [text...], stdin is read instead (heredoc-friendly for
multiline prompts). <slug> also accepts a branch name
(michael/eng-NNNN-...).`;

/**
 * Repo-level session targets, addressable by `send` alongside worktree
 * slugs. Slugs + cwds mirror `tui/sessions/slots.ts` (the TUI slot
 * definitions, which the CLI layer doesn't import) — keep the two in
 * sync. The manager is a NAMED claude session sharing the main clone's
 * cwd; see `core/manager.ts` for why.
 */
const SLOT_TARGETS: Record<string, { cwd: string; managedName: string | null }> = {
  [WT_SOURCE_SLUG]: {
    // <repo>/src/cli/commands → three levels up is the wt source root.
    cwd: resolve(import.meta.dir, "..", "..", ".."),
    managedName: null,
  },
  main: { cwd: config.paths.mainClone, managedName: null },
  dotfiles: { cwd: join(homedir(), ".dotfiles"), managedName: null },
  [MANAGER_SLUG]: { cwd: config.paths.mainClone, managedName: MANAGER_CLAUDE_NAME },
};

/** Resolve a slug-or-branch argument to a live (non-main) worktree. */
async function findWorktree(slugOrBranch: string): Promise<Worktree | null> {
  const slug = slugOrBranch.includes("/")
    ? dirSlug(slugOrBranch)
    : slugOrBranch;
  const wts = (await listWorktrees()).filter((w) => !w.isMain);
  return wts.find((w) => w.slug === slug) ?? null;
}

/**
 * Error path for an unresolvable `send`/`kill` target. A slug in the
 * removed history gets the real answer ("archived on merge (#N, 2h
 * ago)") instead of a bare "no worktree" — the asker is usually the
 * manager wondering where a row went. Otherwise name the addressable
 * set so the listing (`wt claude ls`) and the sender agree.
 */
function explainMissingTarget(slugOrBranch: string): void {
  const slug = slugOrBranch.includes("/") ? dirSlug(slugOrBranch) : slugOrBranch;
  const removed = readWtState().removed.find(
    (e) => e.slug === slug || e.branch === slugOrBranch,
  );
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
      console.error(
        yellow(
          `  UNVERIFIED — still owed: ${verifyStepsHeadline(removed.work!.verifyAfterMerge!)}`,
        ),
      );
    } else if (removed.work) {
      const note = removed.work.note ? `: ${removed.work.note}` : "";
      console.error(dim(`  last status: ${removed.work.state}${note}`));
    }
    return;
  }
  console.error(red(`no worktree: ${slugOrBranch}`));
  console.error(
    dim(
      `addressable: worktree slugs (see wt ls) plus ${Object.keys(SLOT_TARGETS).join(", ")}`,
    ),
  );
}

async function send(slugOrBranch: string, textArgs: string[]): Promise<number> {
  const slot = SLOT_TARGETS[slugOrBranch] ?? null;
  const wt = slot ? null : await findWorktree(slugOrBranch);
  if (!slot && !wt) {
    explainMissingTarget(slugOrBranch);
    return 1;
  }
  // `wt claude send <slug> /dev/stdin <<'MSG'` reads as "take the body
  // from stdin" and is not: stdin is only read when there are NO text
  // args, so the whole message became the literal string "/dev/stdin"
  // and wt reported a successful send of it. Delivering a body that is
  // visibly a handle to the input being ignored is never what anyone
  // meant, and the receiving agent is the one who pays. Refusing costs
  // a retype; guessing cost two worktrees a wasted round each.
  const STDIN_SENTINELS = new Set(["-", "/dev/stdin", "/dev/fd/0"]);
  const joined = textArgs.join(" ").trim();
  if (textArgs.length === 1 && STDIN_SENTINELS.has(joined)) {
    console.error(
      red(`"${joined}" is not a message body — wt reads stdin only when no text is given.`),
    );
    console.error(dim(`  drop the argument to pipe: wt claude send ${slugOrBranch} <<'MSG' ...`));
    return 2;
  }
  const text = (textArgs.length > 0 ? joined : await Bun.stdin.text()).trim();
  if (!text) {
    console.error(red("nothing to send — pass text args or pipe stdin"));
    return 2;
  }
  const slug = slot ? slugOrBranch : wt!.slug;
  // The manager lives as a named Claude session; discovery needs the
  // name persisted before sending (same setup as `wt manager send`).
  if (slug === MANAGER_SLUG) ensureManagerClaudeName();
  // Through the shared choke point, which owns the transport ladder and
  // stamps the sending agent. Agents reach for `wt claude send` exactly
  // as often as the TUI does; neither picks a transport.
  const res = await sendSessionMessage({
    slug,
    cwd: slot ? slot.cwd : wt!.path,
    harnessId: "claude",
    managedName: slot?.managedName ?? null,
    text,
  });
  if (!res.ok) {
    console.error(red(`send failed: ${res.reason}`));
    return 1;
  }
  if (res.delivered === false) {
    console.error(red(`✗ ${slug}'s claude session did not receive the message`));
    console.error(dim("attach via the wt TUI (F12) and check the session"));
    return 1;
  }
  console.log(
    green(
      res.coldStarted
        ? `✓ started ${slug}'s claude session and sent the prompt`
        : `✓ sent the prompt to ${slug}'s claude session`,
    ),
  );
  console.log(
    dim(
      res.transport === "inspector"
        ? res.delivered === null
          ? "submitted at the session's own prompt, where a slash command runs — a command leaves no prompt entry to confirm against; attach via the wt TUI (F12) to watch"
          : "submitted at the session's own prompt, as an ordinary turn — fire-and-forget from here; attach via the wt TUI (F12) to watch"
        : `typed into the session's pane — ${fallbackAdvice(res.fallback)}; attach via the wt TUI (F12) to watch`,
    ),
  );
  return 0;
}

/**
 * `wt claude selftest` — does prompt injection still work?
 *
 * The structural anchors the injector uses live in Claude Code's own
 * React tree, so a Claude Code update is the thing that breaks them.
 * This is the check that says so out loud, before a fleet-wide nudge
 * quietly degrades to typing into panes. `wt doctor` runs it too.
 */
async function selftest(slugOrBranch: string | undefined): Promise<number> {
  const sessions = await listSessions();
  const wanted = slugOrBranch
    ? slugOrBranch.includes("/")
      ? dirSlug(slugOrBranch)
      : slugOrBranch
    : null;
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
  const probes = await Promise.all(
    entries.map(async (entry) => {
      const tmuxSession = claudeTmuxName(entry.slug, entry.name);
      return { tmuxSession, probe: await claudeInjectSelftest(tmuxSession) };
    }),
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
}

async function ls(json: boolean): Promise<number> {
  const sessions = await listSessions();
  const entries = [...sessions.claude].sort((a, b) => a.slug.localeCompare(b.slug));
  if (json) {
    const wts = (await listWorktrees()).filter((w) => !w.isMain);
    const cwdBySlug = new Map<string, string>(wts.map((w) => [w.slug, w.path]));
    for (const [slug, t] of Object.entries(SLOT_TARGETS)) {
      if (!cwdBySlug.has(slug)) cwdBySlug.set(slug, t.cwd);
    }
    const nativeById = new Map(
      claudeSessions.list().map((session) => [session.sessionId, session]),
    );
    const payload = entries.map((e) => {
      const cwd = cwdBySlug.get(e.slug);
      const native = cwd
        ? nativeById.get(wtSessionUuid(cwd, e.name)) ?? null
        : null;
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
        busy: native
          ? native.status === "busy" || native.status === "shell"
          : null,
        waiting_for: native?.waitingFor ?? null,
        last_activity: native && native.updatedAt > 0
            ? new Date(native.updatedAt).toISOString()
            : null,
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
    console.log(
      entry.name === null
        ? entry.slug
        : `${entry.slug}${dim(` ~${entry.name}`)}`,
    );
  }
  return 0;
}

async function stop(slugOrBranch: string): Promise<number> {
  const slot = SLOT_TARGETS[slugOrBranch] ?? null;
  const wt = slot ? null : await findWorktree(slugOrBranch);
  if (!slot && !wt) {
    explainMissingTarget(slugOrBranch);
    return 1;
  }
  const slug = slot ? slugOrBranch : wt!.slug;
  await claudeSessions.stop({
    slug,
    cwd: slot ? slot.cwd : wt!.path,
    managedName: slot?.managedName ?? null,
  });
  console.log(green(`✓ stopped ${slug}'s claude session`));
  return 0;
}

export async function run(argv: string[]): Promise<number> {
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
    return send(slug, text);
  }
  if (first === "ls") return ls(rest.includes("--json"));
  if (first === "selftest") return selftest(rest[0]);
  if (first === "stop" || first === "kill") {
    const [slug] = rest;
    if (!slug || hasHelpFlag([slug])) {
      console.log(USAGE);
      return slug ? 0 : 2;
    }
    return stop(slug);
  }
  console.error(red(USAGE));
  return 2;
}
