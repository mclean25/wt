import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { config } from "../../core/config.ts";
import { readRegistry } from "../../core/harness/claude/registry.ts";
import { claudeAgentAddress } from "../../core/harness/index.ts";
import {
  ensureManagerClaudeName,
  MANAGER_CLAUDE_NAME,
  MANAGER_SLUG,
} from "../../core/manager.ts";
import { dirSlug } from "../../core/stage.ts";
import {
  injectIntoSession,
  killSession,
  listSessions,
  WT_SOURCE_SLUG,
} from "../../core/tmux.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { workAge } from "../../core/work-status.ts";
import { isMergedRemoval, readWtState } from "../../core/wtstate.ts";
import type { Worktree } from "../../core/types.ts";
import { hasHelpFlag } from "../args.ts";
import { dim, green, red } from "../colors.ts";

const USAGE = `usage: wt claude send <slug> [text...]   type a prompt into the worktree's claude session
       wt claude ls [--json]             list live claude sessions
       wt claude kill <slug>             kill the worktree's primary claude session

\`send\` upserts the worktree's PRIMARY Claude Code session: starts it
detached in the wt tmux server when absent (waiting for claude to
finish booting), pastes the text as if typed at the prompt, and
submits it. The prompt lands in the live conversation with its
existing context — not a headless \`claude -p\` run. Fire-and-forget:
there is no completion signal; attach via the TUI (F12) to watch.

Besides worktree slugs, \`send\` accepts the repo-level session slugs
that \`wt claude ls\` lists: wt (the wt source repo), main (the main
clone), dotfiles, and manager (the fleet coordinator — same session
as \`wt manager send\`).

\`ls --json\` adds per-session busy + last_activity from Claude's live
process registry (null when the tmux session has no registered
claude process).

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
  // The manager lives as a named claude session; discovery needs the
  // name persisted before the inject (same dance as `wt manager send`).
  if (slug === MANAGER_SLUG) ensureManagerClaudeName();
  const res = await injectIntoSession({
    slug,
    cwd: slot ? slot.cwd : wt!.path,
    managedName: slot?.managedName ?? null,
    text,
  });
  if (!res.ok) {
    console.error(red(`inject failed: ${res.reason}`));
    return 1;
  }
  // Delivery is CONFIRMED against the conversation transcript, not
  // assumed from "tmux accepted the keys" — a modal over the input box
  // (claude's continue-or-compact picker when it resumes a long
  // conversation) used to eat the prompt while this printed a tick.
  // A fan-out that silently loses 12 of 13 messages is the worst
  // possible failure here, so an unconfirmed send exits non-zero.
  if (res.delivered === false) {
    console.error(
      red(`✗ ${slug}'s claude session did not receive the prompt`),
    );
    console.error(
      dim(
        res.resent
          ? "re-sent once and still nothing in the transcript — attach (F12) and check what the pane is showing"
          : "the session was already running; something in its pane consumed the input — attach (F12) to check",
      ),
    );
    return 1;
  }
  console.log(
    green(
      res.coldStarted
        ? `✓ started ${slug}'s claude session and sent the prompt`
        : `✓ sent the prompt to ${slug}'s claude session`,
    ),
  );
  if (res.resent) {
    console.log(dim("(the first attempt was swallowed on startup; re-sent)"));
  }
  console.log(
    dim(
      res.delivered === null
        ? "delivery unconfirmed — this harness exposes no transcript to check"
        : "delivered — fire-and-forget from here; attach via the wt TUI (F12) to watch",
    ),
  );
  return 0;
}

async function ls(json: boolean): Promise<number> {
  const sessions = await listSessions();
  const entries = [...sessions.claude].sort((a, b) => a.slug.localeCompare(b.slug));
  if (json) {
    // Enrich each live tmux session from Claude's process registry
    // (`~/.claude/sessions/<pid>.json` — the same signal the TUI's
    // status glyphs read), matched by cwd + session name. `busy` /
    // `last_activity` are null when no registered process matches
    // (e.g. claude exited but the tmux session lingers).
    const wts = (await listWorktrees()).filter((w) => !w.isMain);
    const cwdBySlug = new Map<string, string>(wts.map((w) => [w.slug, w.path]));
    for (const [slug, t] of Object.entries(SLOT_TARGETS)) {
      if (!cwdBySlug.has(slug)) cwdBySlug.set(slug, t.cwd);
    }
    const registry = readRegistry();
    const payload = entries.map((e) => {
      const cwd = cwdBySlug.get(e.slug);
      // Registry `name` is the `--name` label wt spawned claude with —
      // the tmux session name, so `<slug>` for a primary and
      // `<slug>~<name>` for a named session (slot primaries carry the
      // slot label, == slug). The name leg matters because slots can
      // share a cwd (main clone + manager) — cwd alone would cross-wire
      // their statuses. The bare-name / "primary" forms are what
      // sessions spawned before names became slug-derived registered
      // as; still matched so a long-lived one keeps reporting.
      const nameMatches = (r: { name: string | null }): boolean =>
        e.name !== null
          ? r.name === `${e.slug}~${e.name}` || r.name === e.name
          : r.name === e.slug || r.name === "primary" || r.name === null;
      const match =
        cwd === undefined
          ? undefined
          : registry
              .filter((r) => r.cwd === cwd && nameMatches(r))
              .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      // Slots register under their label (== slug); worktree sessions
      // under the tmux name. Mismatch → a pre-slug-naming session, and
      // `claudeAgentAddress` returns null rather than a label that
      // could belong to any worktree.
      const expected =
        SLOT_TARGETS[e.slug] !== undefined
          ? e.slug
          : e.name === null
            ? e.slug
            : `${e.slug}~${e.name}`;
      return {
        slug: e.slug,
        name: e.name,
        // The address a peer Claude instance can message this session
        // by directly; null = not addressable, use `wt claude send`.
        agent_name: claudeAgentAddress(match?.name, expected),
        // Listed = a live tmux session (that's what listSessions sees).
        alive: true,
        // "busy"/"shell" mean the agent is mid-turn or running a task;
        // "idle"/"waiting" mean it's sitting at the prompt / blocked.
        busy: match ? match.status === "busy" || match.status === "shell" : null,
        last_activity:
          match && match.updatedAt > 0
            ? new Date(match.updatedAt).toISOString()
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

async function kill(slugOrBranch: string): Promise<number> {
  const slug = slugOrBranch.includes("/")
    ? dirSlug(slugOrBranch)
    : slugOrBranch;
  const sessions = await listSessions();
  const live = sessions.claude.some((e) => e.slug === slug && e.name === null);
  if (!live) {
    console.log(dim(`${slug}: no live primary claude session`));
    return 0;
  }
  await killSession(slug);
  console.log(green(`✓ killed ${slug}'s primary claude session`));
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
  if (first === "kill") {
    const [slug] = rest;
    if (!slug || hasHelpFlag([slug])) {
      console.log(USAGE);
      return slug ? 0 : 2;
    }
    return kill(slug);
  }
  console.error(red(USAGE));
  return 2;
}
