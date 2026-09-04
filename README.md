<p align="center"><img src="docs/logo.png" width="150" alt="wt"></p>

<p align="center"><b>Terminal UI for keeping multiple git worktrees in flight at once.</b></p>

<p align="center"><a href="https://discord.gg/DDnxyXQgF7"><img src="https://img.shields.io/discord/1534621499665813627?label=Discord&logo=discord&logoColor=white&color=5865F2" alt="Discord"></a></p>

Each row shows live status, PR state, preview deployment, issue link, and coding-agent session activity (Claude Code or Codex) for one worktree, so the whole pile of in-progress work is visible on one screen. The configured coding-agent harness can also generate a title and description for each branch through its existing CLI authentication.

The design principle behind all of it: **the human does only the work only a human can do** (merges, logins, judgment calls). Agents assert a per-worktree work status (`wt status` — blocked-on-you / needs-testing / ready-to-merge, with a merge-risk level), the list auto-sorts by what needs you, automations ping only when human action is genuinely required, and a singleton manager session coordinates the fleet. The full rationale and agency model: **[docs/fleet.md](docs/fleet.md)**.

![screenshot](docs/screenshot.png)

## Requirements

**Required**

- [Bun](https://bun.sh) — runtime.
- `git` — worktree mechanics.
- `tmux` — every session wt owns (coding agent, shell, diff, dev server, action runner) lives on a wt-private tmux server, which is what makes them survive wt restarts.
- A [Nerd Font](https://www.nerdfonts.com/) — the TUI uses Nerd Font glyphs for status, PRs, checks, merge-queue position, etc. Without one, those cells render as tofu.
- macOS — `open` and `pbcopy` are assumed for URL/clipboard handling; the webhook daemon installs as a launchd agent; closing a worktree's browser tabs drives Chromium browsers over `osascript` (first use prompts for Automation permission).

**Optional, per integration**

- `gh` (GitHub CLI, authenticated) — the PR row and every in-TUI PR action (auto-merge, mark ready, reviewers, CI log tails).
- `aws` CLI with a profile that can read your SST state bucket — when `[deploy.sst]` is configured (stage row + `wt stages`).
- An editor — `wt open` and the `o`/`O` keybindings. `[editor] command` takes any launcher (`cursor {{path}}`, `code -n`, …); with the section omitted it drives `zed`, which additionally raises an already-open window rather than spawning a second one.
- [`revdiff`](https://github.com/umputun/revdiff) — what `[diff].command` defaults to, so F11 needs it installed unless you override the command. `gitu`, `lazygit`, `tig status`, a `delta` pipe or any script work equally well.
- Issue tracker — no CLI or token; the issue id is parsed from branch slugs and linked via a URL template (`[issue_tracker]`, with a Linear preset), and PRs can open in Linear Reviews.
- Dev server — one supervised `npm run dev`-style process per worktree (`[dev_server]`): wt-owned ports, crash restarts with give-up, tmux-backed so it survives wt restarts.
- Review bot — the CodeRabbit badge/automation track, retargetable at any PR-review bot (`[review_bot]`), including checklist-style GitHub Actions reviewers.
- Coding agents — live sessions are *detected* by reading each agent's local files, no CLI needed; *spawning* from the TUI needs that agent's CLI on PATH (`claude` or `codex`). Claude is the most complete integration; Codex has fewer native status signals.
- A coding-agent CLI (`claude` or `codex`) — live sessions and, when `[naming]` is configured, generated worktree titles and descriptions.
- [`rift`](https://github.com/anomalyco/rift) — an opt-in copy-on-write worktree backend (`[backend] kind = "rift"`): near-instant checkouts that bring `node_modules` across for free. See [docs/backends.md](docs/backends.md).

## Install

```sh
git clone https://github.com/micthiesen/wt.git ~/.wt
cd ~/.wt && bun install
```

Then put the launcher on your `PATH` — a **symlink, not a shell alias**:

```sh
ln -s ~/.wt/bin/wt ~/.local/bin/wt   # any PATH dir you own
```

An alias satisfies interactive use but doesn't exist inside a script file, so anything that scripts wt (an agent looping over worktrees, a cron job) fails with `wt: command not found` partway through. The launcher resolves symlinks to find its own source tree, so linking it anywhere works. `wt doctor` warns when `wt` isn't reachable this way, or resolves to a different clone.

Updating is a fast-forward of that clone: `wt update` does it on demand, and the TUI offers it at startup when new commits have landed (once a day at most, declines remembered). Updates target the newest CI-green commit, boot-probe the result before keeping it, and `wt rollback` (offered automatically after a crash) steps back to the last version that worked — see [docs/updates.md](docs/updates.md). `wt version` prints the running git hash.

## Configure

Keep personal defaults in `~/.config/wt/config.toml`, then initialize each
repository from anywhere inside it:

```sh
wt init
```

This creates a repository-local `.wt.toml`, detects the trunk branch, and
assigns a path-derived namespace (`~/dev/cz/cozee-dev` becomes
`dev-cz-cozee-dev`). The minimal merged configuration is:

```toml
[paths]
main_clone    = "~/Code/your-repo"
worktree_root = "~/Code/your-repo-wt"

[branch]
prefix = "yourname"   # branches you create get `yourname/<id>-<slug>`
```

Everything else is optional and section-gated: add `[deploy.sst]`, `[issue_tracker]`, `[review_bot]`, `[naming]`, or `[github.events]` to turn on or retarget that integration; omit it and the related rows hide themselves (the review-bot track defaults to CodeRabbit). The loader validates everything at startup and prints every missing or malformed field at once.

For multiple repositories, put shared personal defaults in the user config and add a `.wt.toml` at each repository root. Running `wt` within a repository recursively merges its nearest `.wt.toml` over the user config, so repository-specific paths and settings win. Durable state for every repository lives in `~/.local/state/wt/wt.sqlite`, partitioned by that namespace; disposable query caches and runtime files remain under `~/.cache/wt/<repo-id>/`.

The full reference — every option, default, the `[[actions]]` menu, and `[[automations]]` — is in **[docs/configuration.md](docs/configuration.md)**.

## Use

`wt` with no arguments launches the TUI; press `?` inside for the full keymap and glyph legend. Subcommands (`wt new`, `wt rm`, `wt clean`, `wt status`, `wt restack`, `wt manager`, …) run the same operations one-shot from a shell — `wt status` in particular is built for coding agents to call from inside their worktrees, and prints next-step guidance when they do.

The bottom pane defaults to a curated **attention feed** (status transitions, needs-you signals, errors); `"` cycles to the full event firehose. `m` attaches the [manager session](docs/manager.md), the singleton fleet coordinator.

wt also distributes the agent skills and instructions that make all of that work: at startup it offers pending updates y/n (declines remembered per version), following your symlinks and rulesync/dotfiles setup to install them durably for every harness on the machine — see [docs/skills.md](docs/skills.md).

An optional `[remote]` SSH target lets `Ctrl+N` create worktrees on a second
machine configured with `[instance] role = "worker"`, while the controller
keeps their layout beside local rows (marked only by
the server icon). F10/F11/F12 route the selected row's shell, diff, or AI
session over SSH; `!` runs the same action picker against that checkout; and
`d` removes it on that host using the same safety checks as a local worktree. See
[`docs/configuration.md`](docs/configuration.md#remote--optional-ssh-worktree-host).

State is push-based: filesystem watchers on git refs, worktree dirs, and wt's own state feed the UI, so it tracks commits, pushes, installs, and deploys without manual refreshing. An optional webhook daemon extends that to GitHub-side events.

## Docs

| doc | contents |
|---|---|
| [docs/tui.md](docs/tui.md) | TUI tour: layout, full keymap, picker conventions |
| [docs/cli.md](docs/cli.md) | every subcommand and flag |
| [docs/configuration.md](docs/configuration.md) | complete config.toml reference |
| [docs/automations.md](docs/automations.md) | the `[[automations]]` engine: triggers, settle windows, breaker |
| [docs/fleet.md](docs/fleet.md) | the philosophy: minimal human work, work statuses, and the agency levels |
| [docs/skills.md](docs/skills.md) | agent skills & instructions distribution: startup updates, rulesync/symlink awareness |
| [docs/updates.md](docs/updates.md) | self-updates: CI-green targeting, boot probe, crash rollback, data migrations |
| [docs/manager.md](docs/manager.md) | the manager session: the singleton fleet coordinator (`m` / `wt manager`) |
| [docs/github-events.md](docs/github-events.md) | push-based PR/CI updates via a repo webhook |
| [docs/stacked-prs.md](docs/stacked-prs.md) | stacked PRs: fork-base records, inferred stacks, `wt restack` |
| [docs/backends.md](docs/backends.md) | worktree backends: `git-worktree` (default) vs `rift` copy-on-write clones |
| [docs/architecture.md](docs/architecture.md) | internals: layers, freshness model, module conventions |
| [docs/discord.md](docs/discord.md) | Discord server wiring: #updates digest, #github feed, badge |

## Community

Questions, ideas, or a setup to show off — join the [Discord](https://discord.gg/DDnxyXQgF7).

## Logs

Every action and error goes to a daily file at `~/.cache/wt/logs/app/wt-YYYY-MM-DD.log` (14-day retention) — a strict superset of what the activity pane shows. Per-worktree destroy logs live at `~/.cache/wt/logs/<slug>-*.log`; `wt logs <slug>` tails the latest.
