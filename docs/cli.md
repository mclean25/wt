# CLI reference

`wt` with no arguments launches the TUI (when stdout is a TTY; piped output falls back to `wt ls`). Everything below is the one-shot subcommand surface. `wt <cmd> --help` prints per-command usage.

Environment variables: `WT_CONFIG` points at an explicit config file; `XDG_CONFIG_HOME` relocates the default lookup (see [configuration.md](configuration.md)). Both are forwarded into the `wt events` launchd daemon so it loads the same config.

### `wt remote [<command> ...]`

With no arguments, allocate an SSH terminal and enter the `[remote]` host's
interactive `wt`. With arguments, forward the exact argv through a shell-safe
encoded transport to that installation—for example `wt remote ls --json` or
`wt remote new eng-123 --no-install`. Requires the optional `[remote]` config
and an independently configured `wt` on that host.

## Worktree lifecycle

### `wt ls`

List all non-main worktrees (slug, stage when `[deploy.sst]` is configured, PR, status).

- `--json` — machine-readable array (slug, branch, path, stage, status, dirty, issue_id, issue_url, …).

### `wt new <id [title…]|url|branch|slug>`

Create a worktree from an issue id (optionally followed by pasted title words), a tracker URL, an existing branch name, or a bare slug. Runs the full setup: fetch, checkout (`git worktree add`, or a `rift` clone — see [backends.md](backends.md)), env-file and configured-glob copy, SST stage pin (only with `[deploy.sst]` configured), package install (detected from the lockfile, or `[lifecycle] install_command`).

Issue-id input resolves like this:

- `wt new COZ-1953 fix calendar rendering` — id + title words mints `michael/coz-1953-fix-calendar-rendering`.
- `wt new COZ-1953` — bare id mints a fresh branch with a random readable suffix (`michael/coz-1953-cozy-elephant`), so repeat entries just create more worktrees for the same task — that's the intended way to get a second one.
- `wt new --attach COZ-1953` — attach to that id's *existing* branch instead: one match checks out, several offer a picker (interactive shells only — scripted calls error and must pass the branch explicitly), none is an error.
- Multiword input without a leading id (`wt new fix the calendar`) slugifies wholesale to `michael/fix-the-calendar` — issue-less worktrees are first-class.
- With `[issue_tracker] prefix` set (e.g. `"coz"`), a differently-prefixed id (`wt new GH-970 …`) is rejected with guidance: a GitHub issue attaches as the secondary id via `--gh`, never as the worktree's identity.

- `--slug <s>` — explicit slug when creating from an issue id (equivalent to inline title words; wins when both are given).
- `--gh <n>` — attach GitHub issue `#n` as the worktree's secondary id (see `wt issue`).
- `--attach` — attach to an existing branch for the id instead of minting a new one.
- `--base <ref>` — fork base to branch from (recorded; see `wt base`).
- `--any` — with `--attach`, match branches by any author, not just your `branch.prefix`.
- `--open` / `--no-open` — open in Zed after creation (default: open when interactive).
- `--no-install` — skip the package-install step. Ignored under the `rift` backend, which copies packages via its clone.

If the branch already has a worktree, prints its path instead of erroring.

### `wt rm [<slug>]`

Remove a worktree (with dirty/unpushed guards, optional SST stage destroy, optional branch delete). No slug ⇒ interactive picker. The unpushed guard is suppressed for a merged/gone branch — a squash-merged worktree keeps its pre-squash commits locally but the work is landed, so it removes without a spurious `--force`.

- `--yes` / `-y` — skip confirmations.
- `--force` — remove despite uncommitted / unpushed work.
- `--destroy-stage` / `--no-destroy-stage` — force the SST stage decision (default: prompt when your stage looks deployed).
- `--delete-branch` / `--keep-branch` — default deletes the branch.
- `--background` / `-b` — dispatch as a background job (watch with `wt logs <slug>`).

### `wt clean`

Remove every worktree that is merged or whose remote branch is gone. "Gone" is only auto-cleaned when a merged PR confirms the content actually landed; anything riskier is left for an explicit `wt rm`.

- `--yes` / `-y` — skip confirmation (required non-interactively).
- `--destroy-stage` / `--no-destroy-stage` — apply to all candidates (default: per-worktree, destroy iff its stage is live).
- `--foreground` — run removals synchronously (background dispatch is the default here, unlike `rm`).

### `wt doctor [<slug>]`

Health report: working tree, sync vs trunk, SST stage pin + deploy state, node_modules, locks, merged status, PR/CI. One worktree (or the one containing cwd), or all.

- `--all` / `-a` — force the full summary table.
- `--json` — machine-readable.

### `wt open [<slug-or-query>]`

Open a worktree in Zed. Exact slug or case-insensitive substring; no query ⇒ interactive picker.

## Inspection & maintenance

### `wt stages`

List SST stages in the configured state bucket and flag orphans (no matching live worktree). Requires `[deploy.sst]`.

- `--clean` — destroy orphaned stages (`sst remove` per stage, in the main clone).
- `--yes` / `-y` — skip the destroy confirmation.
- `--json` — machine-readable `{live, orphaned}`.

### `wt dev <start|stop|status|logs> [<slug>]`

Manage the worktree's `[dev_server]` (see [configuration.md](configuration.md#dev_server--optional-per-worktree-dev-server)). `start` is also restart; `stop` keeps the slug's port reserved; `logs` prints the supervisor pane's recent output. The slug defaults to the worktree containing the current directory.

### `wt logs [<slug>]`

Tail a destroy log (`tail -F`). No slug ⇒ the most recently modified log.

### `wt base <slug>` / `wt base set <slug> <ref>` / `wt base clear <slug>`

Show / record / forget a worktree's fork base — the branch it's based on when that isn't trunk. This record is the stack primitive (see [stacked-prs.md](stacked-prs.md)): the TUI's base row, stack grouping, sync counts, diff, and AI summary all resolve against it, and `wt restack` replays onto it.

### `wt issue <slug>` / `wt issue <slug> --gh <n>` / `wt issue <slug> --clear-gh`

Show or edit a worktree's issue links. The **primary** id is parsed from the slug (`coz-1935-…` → `COZ-1935`) and is never stored or edited here — it's the worktree's identity. The **secondary** GitHub issue is a per-slug record attached with `--gh <n>` (typically after a spec/breakout issue is created mid-work) and detached with `--clear-gh`; it never changes the branch. The TUI's `i` key and `y i` yank treat an attached GitHub issue as the most-specific link target; `I` / `y I` always target the primary. `<slug>` also accepts a branch name. Both ids appear in `wt ls --json` (`issue_id`/`issue_url`, `gh_issue`/`gh_issue_url`).

## Stacked PRs

### `wt restack [<branch>] [--onto <ref>]`

Rebase the stack containing `<branch>` (default: the current worktree's branch) onto its updated parents — see [stacked-prs.md](stacked-prs.md). Fetches, reconciles each member's fork-base record against landed PRs (a merged parent reparents its children, anchors preserved), then squash-safe-replays every member onto its parent, force-pushes (skipped for branches with no origin counterpart), and retargets PR bases. A standalone worktree is just a one-member chain: it rebases onto its recorded base, or plain trunk when there's no record — so this (and the TUI's `R`) works on every worktree, not only stacks. `--onto <ref>` overrides the trunk the roots land on.

On a merge conflict it exits 3 and names the failing branch + backup branch — `wt` never auto-resolves conflicts; the `/restack` skill (or you) does.

### `wt restack prune-backups [--days <n>]`

Delete the engine's `backup/restack-*` branches older than `--days` (default all).

### `wt skills install [<name>...]`

Install wt's bundled agent skills (`restack`, a `wt` reference skill). No names ⇒ all.

- `--harness <claude|codex|opencode>` — copy into that harness's native skills dir.
- `--rulesync` — copy into a rulesync source dir instead (`--dest` overrides, `--build` regenerates immediately). Mutually exclusive with `--harness`.

## Hub mode

### `wt hub keys <alacritty|wezterm>`

Print a ready-to-paste command-layer config snippet for the given terminal — the cmd+`<key>` chord table that drives hub mode from outside the task pane. See [hub.md](hub.md#the-command-layer) for the concept, and paste the output into `alacritty.toml`'s `[keyboard] bindings` or a WezTerm `config.keys`. No terminal or an unrecognized one prints usage and exits 1.

## Integrations

### `wt events <sub>`

The optional GitHub webhook daemon — see [github-events.md](github-events.md).

| sub | what it does |
|---|---|
| `install` | write the launchd agent + generate the HMAC secret; prints the values to paste into GitHub's webhook settings |
| `start` / `stop` | load / unload the launchd agent |
| `status` | liveness, bind address, pid, delivery count, last fetch/error, snapshot age |
| `secret` | generate or show the HMAC secret |
| `uninstall` | unload + remove the launchd agent |
| `serve` | run the daemon in the foreground (what launchd invokes) |

### `wt claude <sub>`

Drive a worktree's Claude Code tmux session from scripts or other sessions.

| sub | what it does |
|---|---|
| `send <slug> [text...]` | upsert the worktree's primary Claude session (cold-starts it if absent) and paste + submit the text; reads stdin when no text args (heredoc-friendly). Accepts a branch name in place of the slug. Fire-and-forget |
| `ls` | list slugs with a live Claude session |
| `kill <slug>` | kill the worktree's primary Claude session |

---

There is also an internal `wt _destroy` entrypoint that `rm --background` / `clean` spawn for background removals — not for direct use.
