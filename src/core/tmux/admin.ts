import { Duration, Effect } from "effect";

import { killActionSession } from "./action-sessions.ts";
import type { HarnessId } from "../harness/index.ts";
import { createLogger } from "../logger.ts";
import { run } from "../proc.ts";
import {
  bareSlug,
  CLAUDE_NAMED_SEP,
  sessionName,
  SUFFIX,
  TMUX_SOCKET,
} from "./naming.ts";
import { killByName, listAllSessionsRaw } from "./process.ts";

const log = createLogger("[tmux]");

/**
 * Kill the entire wt tmux server (every session). Idempotent — exits
 * 0 when no server is running, after warning to stderr we discard.
 */
export const killServer = run(["tmux", "-L", TMUX_SOCKET, "kill-server"]).pipe(Effect.ignore);

/**
 * Kill one worktree's primary claude session. Idempotent — silently
 * no-ops when the session doesn't exist or the server isn't running.
 * Other kinds and any *named* claude sessions on the same slug are
 * unaffected; use `killClaudeNamedSession` / `killDiffSession` /
 * `killShellSession` for those, or `killAllSessionsFor` to drop
 * every kind at once.
 */
export const killSession = (slug: string) => killByName(sessionName(slug, "claude"));

/** Kill one worktree's named (non-primary) claude session. Idempotent. */
export function killClaudeNamedSession(
  slug: string,
  claudeName: string,
): Effect.Effect<void> {
  return killByName(sessionName(slug, "claude", claudeName));
}

export const killHarnessSession = (
  slug: string,
  harnessId: HarnessId,
  managedName: string | null = null,
) => killByName(sessionName(slug, harnessId, managedName));

/** Whether closing this harness may send its exit gesture through the pane. */
export function closeHarnessUsesPaneInput(harnessId: HarnessId): boolean {
  return harnessId !== "claude";
}

/**
 * End a harness session. Claude is always hard-killed through tmux so
 * lifecycle management never types into its pane or interferes with
 * human input. Other harnesses retain their graceful Ctrl+D-twice exit
 * gesture: their process exits cleanly and the tmux session follows.
 * That path is best-effort because a harness with text in its input box
 * may ignore EOF. Missing sessions are harmless on both paths.
 */
export function closeHarnessSessionGracefully(
  slug: string,
  harnessId: HarnessId,
  managedName: string | null = null,
): Effect.Effect<void> {
  // Claude's pane is never an input transport. Killing the tmux session
  // avoids colliding with partially typed human input; Claude persists
  // its conversation independently of the terminal process lifetime.
  if (!closeHarnessUsesPaneInput(harnessId)) {
    return killHarnessSession(slug, harnessId, managedName);
  }
  const name = sessionName(slug, harnessId, managedName);
  // `=${name}` alone is a valid SESSION target (kill-session) but
  // send-keys resolves a PANE target, where the bare exact-match form
  // errors with "can't find pane". The trailing `:` makes it
  // exact-session + active-window, which pane resolution accepts.
  const send = () => run(["tmux", "-L", TMUX_SOCKET, "send-keys", "-t", `=${name}:`, "C-d"]).pipe(Effect.ignore);
  // A beat between the two presses lets a harness render any exit
  // confirmation before the second key arrives.
  return send().pipe(
    Effect.andThen(Effect.sleep(Duration.millis(200))),
    Effect.andThen(send()),
  );
}

/** Kill one worktree's diff session. Idempotent. */
export const killDiffSession = (slug: string) => killByName(sessionName(slug, "diff"));

/** Kill one worktree's shell session. Idempotent. */
export const killShellSession = (slug: string) => killByName(sessionName(slug, "shell"));

// Action session kills go through `core/tmux/action-sessions.ts` —
// `killAllSessionsFor` below imports the sync helper there. Keeping a
// duplicate definition here would invite drift between two sources of
// truth for the same tmux command.

/**
 * Kill every kind of session for a slug (claude primary + every
 * named claude, diff, shell, action). Used by destroy paths so none
 * linger with cwd inside a half-deleted worktree.
 */
// List once and pick out any session whose bareSlug matches —
// covers primary, named claudes, diff, shell, and action without
// hardcoding the named-claude list. The action kill goes via
// action-sessions.ts (now async like the rest).
export const killAllSessionsFor = Effect.fn("killAllSessionsFor")(function* (slug: string) {
  const all = yield* listAllSessionsRaw();
  const ours = [...all].filter((n) => bareSlug(n) === slug);
  yield* Effect.all([
    ...ours.map((n) => killByName(n)),
    killActionSession(slug),
  ], { concurrency: "unbounded", discard: true });
});

const BASE_PLACEHOLDER = "{{base}}";

/** Whether the user's `[diff].command` template depends on the diff base. */
export function diffCommandUsesBase(template: string): boolean {
  return template.includes(BASE_PLACEHOLDER);
}

/**
 * Substitute `{{base}}` in the user's diff command template with the
 * resolved base ref. The ref is wrapped in double quotes so refs
 * containing characters that the user's shell would otherwise expand
 * (e.g. globs in oddly-named local branches) survive intact.
 *
 * Injection note (audited, accepted): the double-quote escape leaves
 * `$`/backtick live, but it is NOT the load-bearing safety — every
 * caller resolves the base through `effectiveBaseOrTrunk` first, whose
 * rev-parse gate rejects anything that isn't a real commit-ish. Don't
 * route an unvalidated ref into this template without hardening the
 * escape to single-quote (`shQuote`) form first.
 *
 * Templates that don't reference `{{base}}` pass through unchanged so
 * users with custom diff commands (`gitu`, `lazygit`, …) keep working.
 * Templates that do reference it but receive no base resolve the
 * placeholder to the empty string so the user's shell surfaces the
 * resulting parse error visibly rather than us silently masking the
 * misuse.
 */
export function resolveDiffCommand(template: string, base: string | undefined): string {
  if (!diffCommandUsesBase(template)) return template;
  const ref = base ? `"${base.replaceAll('"', '\\"')}"` : "";
  return template.replaceAll(BASE_PLACEHOLDER, ref);
}

/**
 * One live claude session as seen by tmux. `name = null` is the
 * primary (tmux session name = bare slug); a string is a user-named
 * additional session (tmux session name = `<slug>~<name>`).
 */
export type ClaudeSessionEntry = { slug: string; name: string | null };

/** Classified-by-kind view of a set of raw tmux session names, minus `all`. */
export type SessionClassification = {
  claude: ClaudeSessionEntry[];
  claudeSlugs: Set<string>;
  codex: Set<string>;
  opencode: Set<string>;
  diff: Set<string>;
  shell: Set<string>;
  action: Set<string>;
  /** `[dev_server]` supervisor sessions (see core/dev-server.ts). */
  dev: Set<string>;
};

/**
 * Pure classifier behind `listSessions` — split out so the
 * (name → kind) logic is unit-testable without spawning a real tmux
 * server. See `listSessions` for the full semantics.
 */
export function classifySessions(names: Iterable<string>): SessionClassification {
  const claude: ClaudeSessionEntry[] = [];
  const claudeSlugs = new Set<string>();
  const codex = new Set<string>();
  const opencode = new Set<string>();
  const diff = new Set<string>();
  const shell = new Set<string>();
  const action = new Set<string>();
  const dev = new Set<string>();
  for (const name of names) {
    if (name.endsWith(SUFFIX.codex)) {
      codex.add(name.slice(0, -SUFFIX.codex.length));
    } else if (name.endsWith(SUFFIX.opencode)) {
      opencode.add(name.slice(0, -SUFFIX.opencode.length));
    } else if (name.endsWith(SUFFIX.diff)) {
      diff.add(name.slice(0, -SUFFIX.diff.length));
    } else if (name.endsWith(SUFFIX.shell)) {
      shell.add(name.slice(0, -SUFFIX.shell.length));
    } else if (name.endsWith(SUFFIX.action)) {
      action.add(name.slice(0, -SUFFIX.action.length));
    } else if (name.endsWith(SUFFIX.dev)) {
      dev.add(name.slice(0, -SUFFIX.dev.length));
    } else {
      const tildeIdx = name.lastIndexOf(CLAUDE_NAMED_SEP);
      if (tildeIdx > 0) {
        const slug = name.slice(0, tildeIdx);
        const claudeName = name.slice(tildeIdx + 1);
        claude.push({ slug, name: claudeName });
        claudeSlugs.add(slug);
      } else {
        claude.push({ slug: name, name: null });
        claudeSlugs.add(name);
      }
    }
  }
  return { claude, claudeSlugs, codex, opencode, diff, shell, action, dev };
}

/**
 * Bare slug sets (and named-claude entries) for the live sessions of
 * each kind. Partitioned so the indicators, kill-confirm hints, and
 * the sessions picker can each read what they need independently.
 * One CLI call regardless of worktree count.
 *
 * `claude` is a list of `(slug, name)` because a single worktree can
 * host multiple claude sessions (primary + N named). `codex` and
 * `opencode` are slug sets — for v1 they're single-tmux-per-slug.
 * The legacy `claudeSlugs` set is the unique-slug projection of
 * `claude` — preserved so "row has any live claude" checks stay a
 * Set lookup.
 *
 * Server-not-running exits non-zero with a "no server running"
 * stderr; we map that to empty sets rather than throwing — it's the
 * steady state when no worktree has been entered yet.
 */
export function listSessions(): Effect.Effect<
  SessionClassification & {
    /** Raw set of every live tmux session name. Used by harness impls
     *  to compute `isLive` without a second `list-sessions` call. */
    all: Set<string>;
  }
> {
  return listAllSessionsRaw().pipe(
    Effect.map((all) => ({ ...classifySessions(all), all })),
  );
}

/**
 * Reconcile sessions against a live slug set. Kills any session of
 * any kind (claude, diff, or shell) whose underlying slug isn't in
 * `liveSlugs` — covers the case where a worktree was destroyed (in
 * this wt run or a prior one) without our session-kill hook firing.
 * The bare slug is derived by stripping the kind suffix so every
 * kind is reaped for a removed worktree. Errors are swallowed; an
 * orphaned session is a worse outcome than blocking startup.
 */
/**
 * Pure filter behind `reapOrphanedSessions` — split out (like
 * `classifySessions`) so the slug matching is unit-testable without a
 * live tmux server.
 */
export function orphanedSessions(
  sessions: Iterable<string>,
  liveSlugs: ReadonlySet<string>,
): string[] {
  return [...sessions].filter((s) => !liveSlugs.has(bareSlug(s)));
}

export const reapOrphanedSessions = Effect.fn("reapOrphanedSessions")(function* (
  liveSlugs: ReadonlySet<string>,
) {
  const sessions = yield* listAllSessionsRaw();
  const orphans = orphanedSessions(sessions, liveSlugs);
  if (orphans.length === 0) return;
  log.info(`reaping ${orphans.length} orphaned tmux session(s)`, { orphans });
  yield* Effect.all(orphans.map(killByName), {
    concurrency: "unbounded",
    discard: true,
  });
});
