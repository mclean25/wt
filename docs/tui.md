# TUI guide

`wt` with no arguments launches the TUI. Press `?` inside for the built-in keymap + glyph legend (with `/` to filter it) — that overlay is always the most current reference; this page is the tour. The overlay's title also shows the running version (the source clone's git short hash — see [`wt version`](cli.md#wt-version)).

## Layout

- **List pane** (left): one line per worktree — a work-status dot, slug, PR/CI badges, session indicators — grouped into sections, with stacks rendered as trees. The leftmost slot is the colored **work-status dot** (`wt status` / `u`: red needs-human, yellow needs-testing, green ready, magenta review, cyan working, hollow todo; unasserted rows show the same dim hollow dot as todo; a **hollow dot in a state's color** means the assertion is stale — commits landed after it, so re-verify before trusting it), overridden by the loud git states (busy op, missing, gone, merged); uncommitted changes show as a pencil in the right badge cluster. With `[ui] sort = "status"` (default), rows auto-sort inside each section by that urgency — the cursor follows the worktree, not the position. A pinned "review requests" section surfaces PRs waiting on your review.
- **Details pane** (right): a full-width **work-status banner** at the top (state, risk, age, and the complete note, word-wrapped — the same glyph/colors as the list dot; the `u` picker shows the same glyphs per state), then the configured rows (`[ui].rows` in [configuration.md](configuration.md#ui)) for the selected worktree — branch, base, tracker issue, stage, PR, sessions, git state — then a rebase-state block (restacking / mid-rebase / conflict with the clashing files) when something is moving, plus the AI-generated title/description band when `[ai]` is configured. When the row's session just wrapped up, the harness's own summary line renders muted above the AI description (it disappears as soon as the conversation moves on).
- **Bottom pane**: live outputs — harness sessions, action runs, and two event feeds: the curated **attention** feed (status transitions, needs-you signals, errors) and the full firehose. The attention feed is the default whatever row is selected — navigating never flips the pane to a session's output; only a destroy in flight or a just-launched action takes over. `'` picks an output explicitly (remembered per worktree until that output dies), `[` / `]` cycle, `"` jumps to attention (again for the firehose), `Esc` forgets the pick and returns to the default. The feeds **survive restarts** — at boot they're restored from the daily app log (yesterday + today, up to the buffer caps), so the attention trail is still there after wt (or the machine) bounced; identical lines written within a few seconds of each other (several wt processes observing the same transition) are collapsed to one on restore. Scroll them with `Ctrl+E`/`Ctrl+Y` (or `Alt+J`/`Alt+K`, or the mouse wheel); the view re-follows the live tail when you return to the bottom. Once you've worked through what the attention feed is asking for, `x` (while the feed is showing) **marks it seen**: everything up to that moment drops to dim below a `── seen HH:MM:SS` rule, so the feed reads "only new stuff" at a glance while the handled history stays scrollable — nothing is deleted, and the firehose is untouched. The watermark persists (wtstate), so the boot restore comes back already dimmed; an all-dim tail ending in the rule means you're caught up.
- **Footer**: transient content on the left — the active **toast** (keystroke acks like "copied branch", plus background completions: work-status changes, automation fires, action results) or a quiet `? help` hint when idle — and the four special-session buttons grouped at the right: `[m]` the [manager](manager.md) first, then `[.]` the main clone, `[,]` the wt repo, `[/]` dotfiles, each key colored by that session's live state (dim when none). When a live manager claude session has produced a turn, its **context %** renders immediately left of `[m]` (dim; warn at ≥70, red at ≥85 — compact via `M m` before Claude auto-compacts it mid-thought). Replaced by a text prompt when one is active (`n` local new-worktree, `Ctrl+N` remote new-worktree, `L` rename section). Background toasts are always also a line in the bottom pane's feeds — the toast is the flash, the feed is the record — while keystroke acks are toast-only (they answer a key you just pressed).

Freshness is push-based: fs watchers on git refs, worktree dirs, locks, and the state files — plus the optional [GitHub webhook daemon](github-events.md) — invalidate exactly what changed. `r` re-fetches as a backstop; `Ctrl+R` (with confirm) nukes all cached data and refetches from scratch.

## Keymap

### Navigation

| key | action |
|---|---|
| `j`/`k`, arrows | move cursor |
| `g` / `G` | jump to top / bottom |
| `Space` | jump to the next row needing attention (`needs-human` / `needs-testing` / `ready`), scanning forward and wrapping — the cross-section scan that per-section status sort can't express |
| `Tab` | fold/unfold the section under the cursor |
| `Ctrl+J` / `Ctrl+K` | scroll the details pane |
| `Ctrl+E` / `Ctrl+Y` | scroll the bottom event feed (also `Alt+J`/`Alt+K`, mouse wheel); re-follows at the bottom |
| `h` | flip to the removed-worktrees history view |

### Worktree actions

| key | action |
|---|---|
| `n` / `N` | new local worktree prompt (accepts an issue id + optional title words, a tracker URL, branch, or slug, plus `--attach`, `--gh <n>`, `--any`, `--base <ref>` — same resolution as [`wt new`](cli.md#wt-new-id-titleurlbranchslug)); `N` pre-fills `--base` with the selected row's branch. On success the cursor lands on the new row; on a resolution failure the prompt reopens with your input intact |
| `Ctrl+N` | create on `[remote]`; the worktree appears under the server-named remote section with normal status glyphs, and F10/F11/F12 route that row's sessions over SSH |
| `o` | open the worktree in Zed |
| `d` | remove locally or on the row's remote host (confirm; escalates to a force-remove warning when dirty/unpushed) |
| `c` | clean all merged/gone worktrees (confirm) |
| `a` | archive / restore the row, local or remote; archive placement belongs to this TUI's local fleet ledger, while a remote checkout remains untouched on its host |
| `i` | open the most specific issue — the attached GitHub issue (`wt issue --gh`) when present, else the primary tracker issue |
| `I` | open the primary tracker issue (needs `[issue_tracker]` with a URL template, or a `gh-`prefixed slug id) |
| `s` | open the deployed stage URL, or the running `[dev_server]` URL when no stage is deployed |
| `t` | regenerate the AI summary |
| `y` | yank picker — copy branch (`b`), stage (`s`), stage URL (`S`), dev-server URL (`d`), path (`p`), slug (`n`), most-specific issue (`i`), primary tracker issue (`I`), PR URL (`r`); a full picker since the rebuild: `j`/`k` move, `1`–`9` quick-pick, `y`/`Enter` confirm the highlight, direct letters still fire immediately |
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
| `! m` | arm/disarm auto-merge (enqueues into GitHub's merge queue when one is configured) — a `!` picker row since `M` became the manager palette; fires directly, no confirm. Arm-only by construction: on a repo where nothing would block the merge (no protection/queue), GitHub refuses the arm with "clean status" rather than wt ever merging on the spot |
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
| `;` | sessions picker — attach (`; ;`), new named claude (`; c`), new codex/opencode (`; x` / `; o`), graceful close (`; d`), kill (`; x` on a live session row — fires directly, no confirm; getting there already took two deliberate steps) |
| `!` | action picker — run a configured `[[actions]]` entry, `! c` for a custom prompt; `!` on a running action offers to kill it. Two agent-delegation builtins are pinned at the top: `! u` has the row's agent re-assess and assert `wt status`, `! g` has it continue the work per the current status (both inject into the primary harness session, cold-starting it if needed); with `[dev_server]` configured the start/stop pair is pinned below them. `! m` toggles auto-merge (group "github") |
| `,` / `.` / `/` | attach the persistent harness session for the wt repo / main clone / dotfiles |
| `<` / `>` / `\` | slot command palette for the wt repo / main clone / dotfiles session — the shift analog of the attach key (dotfiles rides `\` because shift+`/` is `?`, help). Entries: continue current work (`g`), `/compact` (`m`, fires directly), open the slot in Zed (`z`), custom free-text message (`c`). Prompt entries inject into the slot's session, cold-starting it detached if needed — fire work at a slot without attaching |
| `m` | attach the [manager session](manager.md) — the singleton fleet coordinator |
| `M` | [manager command palette](manager.md#the-command-palette-m) — digest (`d`), triage needs-human (`t`), merge order (`o`), nudge stalled (`n`), audit statuses (`a`), start next todo (`s`), ask about the selected row (`r`), `/compact` (`m`), custom message (`c`); user `[[actions]]` with `target = "manager"` appear too. Fleet commands report back via `wt manager report`, which lands on the attention feed |

Inside these four special sessions, `F10`/`F11`/`F12` all return to wt — slots aren't worktrees, so there's no shell or diff sibling to switch to.
| `O` | open the main clone in Zed (the wt repo's Zed open lives in its palette: `< z`) |
| mouse drag | select text in a wt-managed tmux session and copy it automatically to the macOS clipboard on release |

### Organize

| key | action |
|---|---|
| `l` | section picker (`l l` confirms, `l n` creates a new section) |
| `L` | rename the current section |
| `J` / `K` | move the row (or its whole stack / folded group) down / up — under status sort, within the same status rank only |
| `b` | base picker — record which branch this worktree forked from (`b b` confirms; record-only, never rebases) |
| `u` | work-status picker (`u u` confirms; `t`/`w`/`r`/`n`/`h`/`y` set the state directly, `x` clears; `m` picks the highlighted state and collects an optional note in the footer — Enter on an empty note is a plain pick, Esc cancels the whole pick) — same record as [`wt status`](cli.md#wt-status-slug-state--m-note---risk-r), minus the CLI's risk/note rules (you're the human it escalates to) |
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
| `P` / `Esc` / `q` | open / close |
| `j` / `k` | scroll |
| `i` | send the snapshot to the wt-source session (`,`) as an investigation prompt, then enter that session |
| `r` | resample now |

The overlay also hunts for **leaked headless wt instances** — processes
orphaned to launchd when a terminal died without the process exiting
(the SIGHUP handler makes current builds exit; older builds and wedged
teardowns can survive). Any found get a verdict-level warning plus a
LEAKED section listing pids, CPU, and a ready-to-run `kill` line —
they'd otherwise keep polling GitHub and duplicating attention-feed
lines invisibly. The `i` investigation prompt includes them.

Sampling runs only while the overlay is open (every 2s, four shell-outs)
and stops entirely when it closes — nothing polls in the background, and
the snapshot is never persisted to the query cache.

The same snapshot is available headless as [`wt perf`](cli.md#wt-perf---json)
(`--json` for the raw structure) — the default output is the `i`-key
report, so an agent outside the TUI can be handed one command instead
of a screenshot.

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

### Error overlay

Unhandled errors in the TUI process (uncaught exceptions, unhandled
promise rejections, React render errors) are **captured instead of
printed** — a raw stack trace on stdout/stderr while the renderer owns
the terminal garbles the panes. Captured errors go to a small in-memory
ring (last 5) plus the daily log (full stack), a footer toast flashes,
and this overlay pops automatically. It has no opening key: if another
modal is open it waits its turn and pops when that modal closes;
dismissing acknowledges everything shown, so only a *new* error re-pops
it.

| key | action |
|---|---|
| `j` / `k` | scroll the stack |
| `i` | send the error to the wt-source session (`,`) as an investigate-and-fix prompt, then enter that session |
| `y` | copy the error (origin, timestamp, full stack) to the clipboard |
| `Esc` / `q` | dismiss (acknowledge) |

An **uncaught exception does not kill wt** — the process keeps running
(the state sources are re-derived queries that self-heal), but the
overlay shows a "state may be inconsistent; restart when convenient"
banner for the rest of the run. Identical back-to-back errors collapse
into one entry with a `×N` counter rather than flooding the ring. A
crash *while rendering* can't use a modal (the app tree is gone), so it
gets a minimal full-screen crash view instead: `r` retries the render,
`y` copies, `q` quits cleanly.

Test hook: `WT_DEBUG_THROW=1` (or `=rejection`) fires a synthetic
error ~1.5s after startup — that's how the capture path is probed.

### Removed-worktrees view (`h`)

`j`/`k` navigate, `g`/`G` jump to top/bottom, `p` opens the snapshotted PR, `i` the issue, `y` copies the branch, `Enter` restores the worktree (from the branch if it still exists, else fresh), `h`/`Esc` returns.

## Picker conventions

Every list picker follows the same shape: the key that opened it confirms the highlight when pressed again (`l l`, `; ;`, `' '`, `! !`, `M M`, `< <` / `> >` / `\ \` in the slot palettes, `b b`, `v v`, `u u`, `y y`, and `Shift+F12` again in the harness picker), `Enter` always confirms, `Esc`/`q`/`Ctrl+C` always cancel, `j`/`k` move, and digits `1`–`9` quick-pick when the list is short — except the action picker and the manager/slot palettes (assigned letters instead) and the reviewer picker (`Space` toggles; digits would be ambiguous in a multi-select). Rows with a natural name carry a direct letter chord, shown dim in the row (`u t` → todo, `u y` → ready, `; c` new claude session); special rows get their own letter too (`l n` new section, `! c` custom prompt).

Confirm modals follow the same muscle-memory rule in reverse: the key that opened one also **cancels** it (`d`, `c`, `e`, `E`, `w`, `!`'s kill confirm), alongside the universal `n`/`Esc`/`q`/`Ctrl+C`.

Every text input (the `n`/`N`/`Ctrl+N` new-worktree prompt, `L` section rename, `u m` status notes, `! c` custom prompts and action args, `; c` session names, help search) shares one line editor: `←`/`→` move the cursor, `Home`/`End` (or `Ctrl+A`/`Ctrl+E`) jump to the ends, `Opt/Alt+←`/`→` (or `Esc B`/`Esc F`, or `Ctrl+←`/`→`) jump by word, `Backspace`/`Delete` edit at the cursor, and `Opt/Alt+Backspace` deletes the word left. Word boundaries are slug- and sentence-aware: `-`, `_`, and spaces all separate words. Backspace on an already-empty input still backs out of the prompt.

The title bar's `auto ⏸` chip (inverse, warn-colored) means all automations are paused — a fleet-tier fact deliberately louder than the CPU/usage telemetry next to it.
