import { config } from "../config.ts";
import type { HarnessId } from "../harness/index.ts";

/**
 * Socket name (`-L`) for the wt-private tmux server. A second isolated
 * wt instance (another repo's config, a test/dogfood setup) needs its
 * own tmux universe — session names are only slug-scoped, so two
 * instances on one socket cross-wire same-named sessions (most
 * dangerously the singleton `manager`). Pair it with a relocated
 * `paths.cache_db`, which owns the rest of the state universe.
 *
 * Resolution is `WT_TMUX_SOCKET` → `[tmux] socket` → `"wt"`, and the
 * env var wins because it is the half that propagates into every
 * session the server spawns: a `wt` call made inside an already-running
 * session must resolve the socket it was started under regardless of
 * what any config later says. `[tmux] socket` exists so the recipe is
 * expressible in a repo's `.wt.toml` rather than requiring every entry
 * point to be wrapped in a shell function that exports the var.
 */
export const TMUX_SOCKET = config.tmux.socket;

/**
 * Exit statuses used by the tmux client's `detach-client -E` bindings to
 * request an in-place jump to another worktree session. Keep these away from
 * ordinary command exit statuses so attach failures cannot be mistaken for a
 * navigation request.
 */
export const SESSION_SWITCH_EXIT_CODE = {
  shell: 110,
  diff: 111,
  harness: 112,
} as const;

export type SessionShortcut = keyof typeof SESSION_SWITCH_EXIT_CODE;

export function sessionSwitchTarget(
  code: number | null,
): SessionShortcut | null {
  for (const [target, switchCode] of Object.entries(
    SESSION_SWITCH_EXIT_CODE,
  ) as [SessionShortcut, number][]) {
    if (code === switchCode) return target;
  }
  return null;
}

/**
 * Slug for the persistent harness session at the wt source repo (the
 * `.` keybinding — one of two session slots, see
 * `tui/sessions/slots.ts`). Tmux session name is just `wt`; for the
 * claude harness the conversation also surfaces as `wt` in `/resume`
 * listings. The startup orphan reaper whitelists every slot slug so
 * this session survives the per-slug cleanup sweep.
 */
export const WT_SOURCE_SLUG = "wt";

/**
 * Slugs the session slots own (`tui/sessions/slots.ts`): the wt source
 * repo, the main clone, the dotfiles, and the manager singleton. They
 * share the tmux-session namespace with worktree slugs, so a worktree
 * ACTUALLY slugged one of these would cross-wire its agent session
 * with the slot's (`wt manager send` landing in a feature branch's
 * conversation, `m` attaching to the wrong thing). `createWorktree`
 * refuses them at creation — the one place the collision can be
 * prevented cheaply. Kept here (core layer) because the TUI slots file
 * can't be imported from core.
 */
export const RESERVED_SESSION_SLUGS: readonly string[] = [
  WT_SOURCE_SLUG,
  "main",
  "dotfiles",
  "manager",
];

/**
 * Kinds of session this module manages. `claude` / `codex`
 * are AI harness sessions (each spawned for one worktree at a time);
 * `diff` is the F11 git-diff TUI; `shell` is the F10 plain login
 * shell; `action` is a wt-managed action runner (claude `-p` or shell
 * command) supervised by tmux so it survives wt restarts.
 *
 * Each gets its own tmux session per slug. Naming:
 *  - `<slug>` for claude primary (back-compat)
 *  - `<slug>~<name>` for additional named claude sessions
 *  - `<slug>-codex` for the slug's codex tmux session (one at a time)
 *  - `<slug>-diff` / `<slug>-shell` / `<slug>-action` for non-AI kinds
 *
 * Action sessions are not user-attachable and are not driven by the
 * F-key codepath in this module — `core/tmux/action-sessions.ts` owns their
 * lifecycle. Same story for `dev` (the `[dev_server]` supervisor,
 * owned by `core/dev-server.ts`). Both kinds are registered here so
 * `listSessions` and `reapOrphanedSessions` see them uniformly with
 * the other kinds.
 */
export type SessionKind =
  | "claude"
  | "codex"
  | "diff"
  | "shell"
  | "action"
  | "dev";

export const SUFFIX: Record<Exclude<SessionKind, "claude">, string> = {
  codex: "-codex",
  diff: "-diff",
  shell: "-shell",
  action: "-action",
  dev: "-dev",
};

export function harnessIdForKind(kind: SessionKind): HarnessId | null {
  if (kind === "claude" || kind === "codex") return kind;
  return null;
}

/**
 * Separator between slug and a named claude session's user-supplied
 * name in the tmux session name. `~` was picked because it never
 * appears in slugs (derived from branch names — git accepts most
 * ASCII but `~` collides with reflog syntax in practice) and never in
 * validated session names (see `validateSessionName` in
 * `harness/claude/names.ts`). Stripping is unambiguous: rightmost `~`
 * splits slug from name.
 */
export const CLAUDE_NAMED_SEP = "~";

/**
 * Tmux session name for a (slug, kind, managedName). Claude has a
 * primary-vs-named distinction encoded in the name (`<slug>` vs
 * `<slug>~<name>`); every other kind uses a single fixed suffix
 * (`<slug>-<suffix>`). Codex is single-tmux-per-slug, so
 * `managedName` is ignored for it.
 */
export function sessionName(
  slug: string,
  kind: SessionKind,
  managedName: string | null = null,
): string {
  if (kind === "claude") return claudeSessionName(slug, managedName);
  return `${slug}${SUFFIX[kind]}`;
}

/**
 * Tmux session name for a claude session. Primary (`name = null`) is
 * the bare slug; named is `<slug>~<name>`. Single source of truth so
 * every consumer (tmux composer, session-tail key, activity-pane log
 * line) agrees on the format.
 */
export function claudeSessionName(slug: string, name: string | null): string {
  return name === null ? slug : `${slug}${CLAUDE_NAMED_SEP}${name}`;
}

/**
 * Single-quote a path for safe interpolation into a /bin/sh command
 * string. Used by the pipe-pane redirect target — `homedir()` paths
 * can contain spaces ("My Name" accounts on macOS), so a raw splice
 * would break the redirect. Embedded single quotes are escaped via
 * `'\''` per POSIX shell convention.
 */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Recover the bare slug from a tmux session name.
 *
 * A `~` in the name unambiguously marks a named claude session: the
 * slug is everything before the rightmost `~`. The kind suffix
 * (`-codex` / `-diff` / `-shell` / `-action`) is only
 * a possibility for names that have NO `~`, since named claudes are
 * claude-only and never carry a kind suffix.
 *
 * Pre-existing collision: a slug ending in any of the kind suffixes
 * (a description like "Add codex" or a branch like `eng-1234-codex`
 * slugifies into one) makes its primary claude session
 * indistinguishable from a same-namespace `<bare>-codex` session in
 * tmux. `-codex` and `-dev` make this materially riskier
 * than the old `-diff`/`-shell` collisions because those are
 * plausible branch-description words. The only proper fixes are
 * slug-level validation or moving kinds to a separator that can't
 * appear in slugs. Out of scope here; flagged for a future sweep.
 */
export function bareSlug(name: string): string {
  // Strip a trailing `~<name>` if present (claude named, or any
  // future per-id-named harness session).
  const tildeIdx = name.lastIndexOf(CLAUDE_NAMED_SEP);
  const beforeTilde = tildeIdx >= 0 ? name.slice(0, tildeIdx) : name;
  // Strip the kind suffix (`-codex`, `-diff`, `-shell`, `-action`) from
  // what's left. Longest suffix goes first for future-safe matching.
  const suffixes = Object.values(SUFFIX).sort((a, b) => b.length - a.length);
  for (const suffix of suffixes) {
    if (beforeTilde.endsWith(suffix)) return beforeTilde.slice(0, -suffix.length);
  }
  return beforeTilde;
}
