import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { config } from "../../core/config.ts";
import { wtSessionUuid } from "../../core/harness/claude/jsonl.ts";
import { claudeSessions } from "../../core/harness/claude/sessions.ts";
import {
  isSlashCommand,
  sendSessionMessage,
} from "../../core/harness/session-messaging.ts";
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
import { workAge } from "../../core/work-status.ts";
import { isMergedRemoval, readWtState } from "../../core/wtstate.ts";
import type { Worktree } from "../../core/types.ts";
import { hasHelpFlag } from "../args.ts";
import { dim, green, red } from "../colors.ts";

const USAGE = `usage: wt claude send <slug> [text...]   send a prompt to the worktree's claude session
       wt claude ls [--json]             list live claude sessions
       wt claude stop <slug>             stop the worktree's primary claude session

\`send\` upserts the worktree's PRIMARY Claude Code session: starts it
detached in the wt tmux server when absent (waiting for claude to
finish booting), then delivers the prompt through Claude Code's native
session messaging transport. The prompt lands in the live conversation
with its existing context — not a headless \`claude -p\` run. Fire-and-forget:
there is no completion signal; attach via the TUI (F12) to watch.

Besides worktree slugs, \`send\` accepts the repo-level session slugs
that \`wt claude ls\` lists: wt (the wt source repo), main (the main
clone), dotfiles, and manager (the fleet coordinator — same session
as \`wt manager send\`).

\`ls --json\` adds the stable session id, pid, cwd, native socket,
tmux identity, status, and last activity. The messaging token is never
printed.

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
  const text = (
    textArgs.length > 0 ? textArgs.join(" ") : await Bun.stdin.text()
  ).trim();
  if (!text) {
    console.error(red("nothing to send — pass text args or pipe stdin"));
    return 2;
  }
  const slug = slot ? slugOrBranch : wt!.slug;
  // The manager lives as a named Claude session; discovery needs the
  // name persisted before sending (same setup as `wt manager send`).
  if (slug === MANAGER_SLUG) ensureManagerClaudeName();
  // Through the shared choke point, not `claudeSessions.send` directly:
  // that is where the socket-vs-pane transport rule lives, and a slash
  // command sent over the socket is a silent no-op (see
  // `sendSessionMessage`). Agents reach for `wt claude send` exactly as
  // often as the TUI does.
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
  console.log(
    green(
      res.coldStarted
        ? `✓ started ${slug}'s claude session and sent the prompt`
        : `✓ sent the prompt to ${slug}'s claude session`,
    ),
  );
  console.log(
    dim(
      isSlashCommand(text)
        ? "submitted at the session's prompt (a slash command has to be typed, not messaged) — attach via the wt TUI (F12) to watch"
        : "delivered through Claude's native session messaging — fire-and-forget from here; attach via the wt TUI (F12) to watch",
    ),
  );
  return 0;
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
      (await claudeSessions.list()).map((session) => [session.sessionId, session]),
    );
    const payload = entries.map((e) => {
      const cwd = cwdBySlug.get(e.slug);
      const native = cwd
        ? nativeById.get(wtSessionUuid(cwd, e.name)) ?? null
        : null;
      return {
        slug: e.slug,
        name: e.name,
        session_id: native?.sessionId ?? null,
        pid: native?.pid ?? null,
        cwd: cwd ?? null,
        socket_path: native?.socketPath ?? null,
        tmux_session: e.name === null ? e.slug : `${e.slug}~${e.name}`,
        alive: true,
        status: native?.status ?? null,
        busy: native
          ? native.status === "busy" || native.status === "shell"
          : null,
        last_activity: native && native.updatedAt > 0
            ? new Date(native.updatedAt).toISOString()
            : null,
        source: native?.source ?? null,
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
