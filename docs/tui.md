# TUI guide

`wt` with no arguments launches the TUI. Press `?` inside for the built-in keymap + glyph legend (with `/` to filter it) — that overlay is always the most current reference; this page is the tour.

## Layout

- **List pane** (left): one line per worktree — a work-status dot, slug, PR/CI badges, session indicators — grouped into sections, with stacks rendered as trees. The leftmost slot is the colored **work-status dot** (`wt status` / `u`: red needs-human, yellow needs-testing, green ready, magenta review, cyan working, hollow todo; blank when unasserted), overridden by the loud git states (busy op, missing, gone, merged); uncommitted changes show as a pencil in the right badge cluster. With `[ui] sort = "status"` (default), rows auto-sort inside each section by that urgency — the cursor follows the worktree, not the position. A pinned "review requests" section surfaces PRs waiting on your review.
- **Details pane** (right): the configured rows (`[ui].rows` in [configuration.md](configuration.md#ui)) for the selected worktree — branch, base, tracker issue, work status (with risk, age, and note), stage, PR, sessions, git state — then a rebase-state block (restacking / mid-rebase / conflict with the clashing files) when something is moving, plus the AI-generated title/description band when `[ai]` is configured.
- **Bottom pane**: live outputs — harness sessions, action runs, and two event feeds: the curated **attention** feed (status transitions, needs-you signals, errors — the default) and the full firehose. Auto-follows the selected row; `'` picks an output explicitly, `[` / `]` cycle, `"` jumps to attention (again for the firehose), `Esc` returns to auto-follow.
- **Footer**: key legend, or a text prompt when one is active (`n` local new-worktree, `Ctrl+N` remote new-worktree, `L` rename section).

Freshness is push-based: fs watchers on git refs, worktree dirs, locks, and the state files — plus the optional [GitHub webhook daemon](github-events.md) — invalidate exactly what changed. `r` re-fetches as a backstop; `Ctrl+R` (with confirm) nukes all cached data and refetches from scratch.

## Keymap

### Navigation

| key | action |
|---|---|
| `j`/`k`, arrows | move cursor |
| `g` / `G` | jump to top / bottom |
| `Tab` | fold/unfold the section under the cursor |
| `Ctrl+J` / `Ctrl+K` | scroll the details pane |
| `h` | flip to the removed-worktrees history view |

### Worktree actions

| key | action |
|---|---|
| `n` / `N` | new local worktree prompt (accepts an issue id + optional title words, a tracker URL, branch, or slug, plus `--attach`, `--gh <n>`, `--any`, `--base <ref>` — same resolution as [`wt new`](cli.md#wt-new-id-titleurlbranchslug)); `N` pre-fills `--base` with the selected row's branch |
| `Ctrl+N` | create on `[remote]`; the worktree appears under the server-named remote section with normal status glyphs, and F10/F11/F12 route that row's sessions over SSH |
| `o` | open the worktree in Zed |
| `d` | remove locally or on the row's remote host (confirm; escalates to a force-remove warning when dirty/unpushed) |
| `c` | clean all merged/gone worktrees (confirm) |
| `a` | archive / restore the row |
| `i` | open the most specific issue — the attached GitHub issue (`wt issue --gh`) when present, else the primary tracker issue |
| `I` | open the primary tracker issue (needs `[issue_tracker]` with a URL template, or a `gh-`prefixed slug id) |
| `s` | open the deployed stage URL, or the running `[dev_server]` URL when no stage is deployed |
| `t` | regenerate the AI summary |
| `y` | yank menu — copy branch (`b`), stage (`s`), stage URL (`S`), dev-server URL (`d`), path (`p`), slug (`n`), most-specific issue (`i`), primary tracker issue (`I`), PR URL (`r`) |
| `r` / `Ctrl+R` | refresh / hard refresh (clear caches, confirm) |

When the SSH host is sleeping or offline, its last-known worktrees remain in
the Inbox with `host unavailable`. The title bar also shows an offline warning;
F10/F11/F12 resume once a refresh reaches the host again.
Remote deletion also stays disabled while the worktree holds a live operation
lock. It deletes the remote branch but never destroys an SST stage implicitly.

### Pull request

| key | action |
|---|---|
| `p` | open the PR at the configured `[github].pr_target` |
| `g p` / `l p` | open the PR explicitly in GitHub / Linear Reviews (1.2s chord) |
| `e` | mark a draft PR ready (confirm) |
| `E` | "ship it": mark ready + request `[github].default_reviewer` + arm auto-merge, in one confirm |
| `M` | toggle auto-merge (enqueues into GitHub's merge queue when one is configured) |
| `f` | tail the failing CI checks' logs into the activity pane |
| `v` | reviewer picker (`Space` toggles, `v v` submits) |
| `w` | (review-requests section) check the PR's branch out as a worktree |

### Sessions

Sessions live in a dedicated tmux server; "enter" takes over the terminal, and the same key detaches back to the TUI.

| key | action |
|---|---|
| `F12` | enter the row's coding-agent session (most recent live one, else spawn the primary harness); from another worktree session, switch straight to it; press again to return home; `Ctrl+D` closes it gracefully |
| `Shift+F12` | pick a harness (claude / codex / opencode) for a fresh spawn |
| `Shift+Tab` | cycle the primary harness |
| `F11` | enter the row's diff session (`[diff].command`, default `revdiff`, against the resolved diff base); from another session, switch straight to it; press again to return home |
| `F10` | enter the row's plain shell session; from another session, switch straight to it; press again to return home |
| `Shift+F10` / `Shift+F11` | kill the shell / diff session (confirm) |
| `;` | sessions picker — attach (`; ;`), new named claude (`; c`), new codex/opencode (`; x` / `; o`), graceful close (`; d`), kill (`; x` on a session row) |
| `!` | action picker — run a configured `[[actions]]` entry, `! c` for a custom prompt; with `[dev_server]` configured the start/stop pair is pinned at the top; `!` on a running action offers to kill it |
| `,` / `.` / `/` | attach the persistent harness session for the wt repo / main clone / dotfiles |
| `m` | attach the [manager session](manager.md) — the singleton fleet coordinator (auto-merge moved to `M`) |
| `>` / `O` | open the wt repo / main clone in Zed |
| mouse drag | select text in a wt-managed tmux session and copy it automatically to the macOS clipboard on release |

### Organize

| key | action |
|---|---|
| `l` | section picker (`l l` confirms, `l n` creates a new section) |
| `L` | rename the current section |
| `J` / `K` | move the row (or its whole stack / folded group) down / up — under status sort, within the same status rank only |
| `b` | base picker — record which branch this worktree forked from (`b b` confirms; record-only, never rebases) |
| `u` | work-status picker (`u u` confirms, `x` clears) — same record as [`wt status`](cli.md#wt-status-slug-state--m-note---risk-r), minus the CLI's risk/note rules (you're the human it escalates to) |
| `R` | rebase/restack the selected row — a stack member restacks the whole stack, a standalone worktree rebases onto its recorded base or trunk; same engine as [`wt restack`](stacked-prs.md) (fetch + reconcile + squash-safe replay). On a conflict bail it hands off automatically: `/restack` is injected into the failing worktree's session (cold-starting it if needed) to resolve and finish. Locks per chain, so different stacks/worktrees restack concurrently; members show the sync glyph while it runs (warn-tinted when mid-rebase). Refuses on an already-landed row — that's `c`'s job |

### Automations

| key | action |
|---|---|
| `A` | pause/resume all automations |
| `Ctrl+A` | pause/resume the selected worktree (or its whole stack) |

### Perf overlay (`P`)

Answers one question: *the machine feels slow — is that us?*

A filtered `btop` scoped to everything descending from the wt process or
its private tmux server. The headline is a verdict line (wt's share of
the CPU actually in use, not of installed capacity — the latter reads
reassuringly small on a 12-core box even when wt owns all of it),
followed by system meters, a breakdown by category (agents, tests,
typecheck/lint, dev servers, wt, tmux, shells), a breakdown by worktree
session, and the heaviest processes both inside and outside wt's tree.
That last block is the point: when the hog is a browser tab, it says so
instead of sending you hunting through worktrees.

| key | action |
|---|---|
| `P` | open / close |
| `j` / `k` | scroll |
| `i` | send the snapshot to the wt-source session (`,`) as an investigation prompt, then enter that session |
| `r` | resample now |

Sampling runs only while the overlay is open (every 2s, four shell-outs)
and stops entirely when it closes — nothing polls in the background, and
the snapshot is never persisted to the query cache.

Two accuracy notes. CPU percentages come from `ps` `%CPU`, which is a
**lifetime decaying average, not an instantaneous sample** — a process
showing 130% may be idle right now. Read it as sustained pressure; the
overlay is not a profiler. Memory "used" is computed from `vm_stat` as
active + wired + compressor pages (Activity Monitor's definition) rather
than `os.freemem()`, which counts only genuinely free pages and so reads
~90% used on any machine that's been up a while.

Unrelated but adjacent: `WT_PERF=1 bun src/main.ts` arms an event-loop
lag probe that logs whenever wt's own render thread blocks. That's the
tool for "j/k feels laggy"; this overlay is the tool for "the whole
machine feels slow".

### Removed-worktrees view (`h`)

`j`/`k` navigate, `p` opens the snapshotted PR, `i` the issue, `y` copies the branch, `Enter` restores the worktree (from the branch if it still exists, else fresh), `h`/`Esc` returns.

## Picker conventions

Every list picker follows the same shape: the key that opened it confirms the highlight when pressed again (`l l`, `; ;`, `' '`, `! !`, `b b`, `v v`), `Enter` always confirms, `Esc`/`q`/`Ctrl+C` always cancel, `j`/`k` move, and digits `1`–`9` quick-pick when the list is short. Special rows get their own letter (`l n` new section, `! c` custom prompt, `; c` new claude session).

