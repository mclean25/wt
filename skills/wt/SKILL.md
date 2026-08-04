---
name: wt
description: >-
  Use the `wt` CLI/TUI to manage git worktrees: create, list, inspect, remove,
  and drive per-worktree Claude Code sessions, plus stacked PRs (worktrees
  based on other worktrees, restacked with `wt restack`). TRIGGER when the
  user mentions wt, worktrees, "a wt", stacking, or restacking. For conflict
  resolution during a restack use the dedicated /restack skill; this is
  general orientation.
targets:
  - '*'
---
# wt — worktree CLI/TUI

`wt` is a terminal UI + CLI for keeping multiple git worktrees in flight at
once. A main clone stays on the trunk branch (`[branch] base` — `main` here,
`staging` on cozee-dev); active branches live in per-worktree checkouts under a
configured `worktree_root`. Each row shows live git status, PR state,
preview-deploy state, issue id/link, review-bot state, and coding-agent session
activity.

Config lives at `~/.config/wt/config.toml`, with the nearest `.wt.toml` (from
cwd upward) recursively merged over it for repo-specific settings like the
trunk branch (`wt` refuses to start without the required fields; the loader
reports every missing field at once). The standard install aliases
`wt='~/.wt/bin/wt'`; if `wt` isn't found in a non-interactive shell, invoke
`~/.wt/bin/wt` directly.

## Subcommands

- `wt` — interactive TUI (vim keys: `j`/`k`/Enter, `?` for help).
- `wt ls` — list worktrees.
- `wt new <input>` — create a worktree (and branch). Input is an issue id with
  optional pasted title words (`wt new COZ-1953 fix calendar rendering` →
  `michael/coz-1953-fix-calendar-rendering`), a tracker URL, a branch, or a
  bare slug. A bare id attaches to that id's existing branch (or creates
  `michael/coz-1953` if none); giving title words or `--slug` always mints a
  fresh branch — that's how a second worktree for an in-flight id is made.
  `--base <ref>` forks from a non-trunk parent and records it — the record
  that stacks the new worktree on that parent (diff base, TUI grouping,
  restack target).
- `wt rm [slug]` — remove a worktree (optionally its branch).
- `wt clean` — bulk-remove merged/gone worktrees.
- `wt doctor [slug]` — health report (dirty, sync, PR, merged).
- `wt open [slug]` — open a worktree in the editor.
- `wt base <slug> | set <slug> <ref> | clear <slug>` — show/set/clear a
  worktree's recorded fork base (the stack primitive).
- `wt restack [<branch>] [--onto <ref>]` — rebase a worktree (or the whole
  stack containing it) onto its updated parents: reconcile records against
  landed PRs, squash-safe replay, force-push, retarget PR bases. Standalone
  worktrees rebase onto their recorded base or plain trunk — it works on
  every worktree, not only stacks. `wt restack prune-backups` sweeps the
  engine's `backup/*` refs.
- `wt logs [slug]` — tail background-destroy logs.

Every subcommand runs non-interactively when stdout isn't a TTY. Run
`wt <command> --help` for per-command options.

## Stacked PRs

There is no managed stack state: a worktree whose recorded base names another
live worktree's branch is stacked on it, and chains of those records render as
a stack in the TUI (tree spine, shared section, AI-titled header). Merged
parents reparent their children automatically (clean/destroy and restack both
preserve each child's squash-safe anchor), and `wt restack` / the TUI's `R`
realign the commits. When a restack hits a conflict, use **/restack** to
resolve it faithfully.

## User Instructions

$ARGUMENTS
