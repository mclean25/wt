# Architecture

Internals map for contributors and coding agents. Bun + React + [OpenTUI](https://github.com/sst/opentui) on top of TanStack Query. The companion rules file for agents is [`CLAUDE.md`](../CLAUDE.md); this page is the *map*, that one is the *rules*.

## The three layers

The TUI is split into three layers; respect the boundaries:

- **Sources** — `src/state/queries/` (per-source files behind the `src/state/queries.ts` barrel), `src/state/hooks.ts`, `src/tui/hooks/useWorktreeRows.ts`. They own fetching, batching, and caching via TanStack Query. Small fixed set (github, git, sst, dev-server, claude, issue-tracker-derived, ai); not user-pluggable.
- **Rows** — `src/tui/rows/*.tsx`. Pure-presentational modules declaring `{id, label, sources, render, visible?}`. Multiple rows can read from the same source; the source still fetches once. `src/tui/rows/index.ts` is the registry; `[ui].rows` in the user config selects + orders them, and a row hides itself when its integration isn't configured.
- **Driver** — `src/tui/panels/details.tsx`. Iterates the configured row list, computes the trailing staleness glyph, and renders inline errors verbatim once retries are exhausted. Also owns the AI title/description band above and below the row stack — pane-level chrome, not a row.

The list panel (`src/tui/panels/list.tsx`) is deliberately **not** row-driven — different layout (one line of glyphs, no labels). Don't try to unify them.

## Composition root

`src/tui/app.tsx` wires everything: state declarations, hook wiring, per-render flow factories, the ctx objects key handlers destructure, and the layout JSX. The pieces:

- **Keyboard** — `src/tui/keyboard/` (`global-keys.ts`, `footer-input-keys.ts`, `removed-view-keys.ts`, `normal-keys.ts`) plus `src/tui/modal-keys/` (one file per modal family; `index.ts` is the dispatcher). The `useKeyboard` callback in app.tsx only routes, in load-bearing order: modal → footer input → removed view → `h` toggle → normal mode. Handler-check order *inside* `normal-keys.ts` is also load-bearing (see its header comment).
- **Flows** — `src/tui/flows/` (`destroy.ts`, `sessions.ts`, `github-pr.ts`, `sections.ts`, `base.ts`, `reviewers.ts`, `new-worktree.ts`, `action-picker.ts`, `perf-report.ts` — per-render factories over a context object) and `src/tui/hooks/useActionDispatch.ts` (action launch + completion subscriber). New flow logic goes in a flows module, not back into app.tsx.
- **Modal overlays** — `src/tui/modal-host.tsx` (`PreFooterModals` mount before the Footer, `PostFooterModals` after; render order is paint order). The modal union lives in `src/tui/modal-state.ts`; `modal.tsx` is the shared chrome component.
- Pure helpers in `src/tui/app-helpers.ts`; title-bar badges in `src/tui/usage-badge.tsx`.

## Module layout conventions

The big core modules are directories behind a same-named flat barrel: `core/github.ts` → `core/github/`, `core/wtstate.ts` → `core/wtstate/`, `core/stack-ops.ts` → `core/stack-ops/`, `core/actions.ts` → `core/actions/`, `core/tmux.ts` → `core/tmux/`, `core/skills.ts` → `core/skills/` (the skills-distribution system — [skills.md](skills.md); its interactive prompt flow lives CLI-side in `cli/skills-sync.ts`, shared by `wt skills sync` and the pre-TUI startup check in `main.ts`), `state/queries.ts` → `state/queries/`. The barrel re-exports the module's public surface with explicit named re-exports — importers keep using the flat path; only names in the barrel are public. (`tui/modal-keys/` is a plain directory — its single consumer imports `index.ts` directly.)

Per-harness code (claude/codex/opencode session discovery, naming, events, usage, tails) lives under `core/harness/<harness>/` behind the generic `Harness` interface (`core/harness/types.ts`); `core/harness/status.ts` is the shared `DerivedState` vocabulary.

Worktree **backends** follow the same shape: `core/backend.ts` → `core/backend/` behind the narrow `WorktreeBackend` interface (`create` / `remove` — the only two filesystem mutation points, extracted from `lifecycle.ts`). Two built-ins: `git-worktree` (linked worktrees, one shared object db) and `rift` (copy-on-write clones). Everything else wt does to a worktree (fork-base record, env/configured-glob copy, stage pin, upstream, status) stays backend-agnostic in `lifecycle.ts` / `worktree.ts`. `getBackend(kind)` picks the create backend from config; `getBackendForPath(path)` derives the owning backend from disk (a `.rift` marker) so removal is correct after a config flip. This is the LOCAL-materialization axis, orthogonal to any remote (SSH-host) axis. See [backends.md](backends.md).

## Freshness model

Freshness is **push-based**; the `r` keybind is a backstop, not the mechanism. Every external state source has an event trigger that invalidates the matching query:

| trigger | invalidates |
|---|---|
| `.git/refs/` watcher (commits, fetches, pushes) | github + per-worktree fields + wtState + reviewRequests (deliberately keyed outside the `["github"]` prefix) |
| `.git/worktrees/` watcher (worktree add/remove) | worktree list |
| worktree-root watcher (subdir add/remove) | worktree list — catches `rift` checkouts, which are independent clones that never touch `.git/worktrees/`; harmlessly redundant for git worktrees |
| `.git/worktrees/<slug>/rebase-{merge,apply}` watcher (hand/`/restack` rebase starts or ends) | that slug's conflict probe (the mid-rebase glyph) |
| per-worktree dir watchers | edits → dirty; `.sst/` writes → deploy |
| `~/.cache/wt/state.json` + `archive.json` watcher | cross-process fork-base / section / archive writes |
| `~/.cache/wt/locks/` watcher | per-slug busy state from any process (create/destroy, and every chain member during a restack — the restack glyph rides on this); a release also fans out a per-slug field refresh (`useLockReleasedInvalidator`) **and refreshes the worktree list** — the reliable "a create/destroy just finished" signal, so a new (esp. `rift`) row surfaces immediately instead of waiting on the interval (a rift `.rift` marker is written inside the new dir, after the worktree-root watcher already fired on the bare dir) |
| github-events webhook marker | github + a forced `git fetch origin` |
| 3-minute `fetch origin` interval | backstop for remote drift |
| claude-registry fs.watch, session-tail triggers (`gh pr …` / `git push` inside a session) | sessions / github / claudeUsage (a registry rewrite IS claude activity, exactly when API utilization changes) |
| `tmuxSessionsQuery`'s `dev` set (batched tmux read, 5s poll + push-invalidated) | `wtDevQuery`'s session-liveness half — the value is part of that query's key, so a session start/stop cache-misses into an immediate refetch instead of spawning a redundant per-worktree `tmux has-session`; the port-probe half keeps its own 15s poll as backstop |
| codex/opencode activity-poller ticks (`startCodexEventPolling` / `startOpencodeEventPolling`, the same 2.5s tickers that feed the activity pane) | codexUsage / opencodeCost, on ticks that actually observed an event — token usage and spend change exactly when those sessions are active, so this rides the existing sensor instead of leaving the query poll-only |
| action `affects` tags on completion | the declared domains (`git`, `github`, `dev` — the dev-server start/stop builtins declare `dev`, refreshing the slug's fields; a 15s poll backstops out-of-band crashes) |
| manager-reports spool watcher (`~/.cache/wt/manager/reports.jsonl`, written by `wt manager report`) | nothing query-shaped — new lines are narrated straight onto the attention feed (`useManagerReports`; 10s poll backstop). The footer's manager context % is likewise push-based, riding the session-tail registry's per-turn `lastUsage` rather than any query |

One deliberate exception: `perfSnapshotQuery` (the `P` overlay) polls as its *primary* mechanism, not as a backstop. Nothing emits an event when some process starts burning CPU, and the overlay's whole job is to show the number moving. It's gated hard on the modal being open (`enabled`), so it samples at 2s while visible and not at all otherwise, and it's excluded from the persister — a restored snapshot is a previous run's dead pids. Don't treat it as precedent for polling a source that *does* have a trigger available.

When adding a new state source or mutation path, wire one of these (or an explicit invalidation at the call site) rather than shortening a staleTime — staleTimes only bound how wrong things can be when a trigger is missed. Watchers live in `src/core/repo-watch.ts` and are wired in `src/tui/runtime.tsx` through a 50ms-coalescing invalidation scheduler.

Two related invariants:

- The github source is **one GraphQL round-trip** aliasing every per-worktree PR field plus the repo merge-queue block. New PR fields go into `PR_FRAGMENT` in `core/github/fetch.ts`, never a separate query.
- Anything that *mutates* GitHub state must invalidate `["github"]` (via `refreshGithub()` in `state/hooks.ts`), not the worktree — the github query is keyed by branch list, not slug.

## Remote execution

The optional `[remote]` host owns its clone, worktree paths, locks, and tmux
processes, while the Mac owns the single visible TUI. `remoteWorktreesQuery`
polls the host's `wt ls --json` and renders those summaries in a host-named
remote section; remote filesystem paths are never accessed as if they were local.
The query's successful inventory is persisted for offline startup and retained
across refetch failures. SSH failure changes host health only: the host header
renders a warning and session keys are disabled until a later poll succeeds.

`core/remote.ts` drives SSH, while `core/remote-protocol.ts` base64url-encodes
the complete argv into a single shell-safe token. The remote `_remote` CLI
entrypoint decodes that token and re-enters normal dispatch, avoiding any
dependency on remote login-shell quoting.

`Ctrl+N` forwards `wt new` and refreshes the remote-row query when creation
finishes. F10/F11/F12 on a remote row use the hidden `_session` entrypoint;
Cachy runs that one worktree's tmux session while `renderer-handoff.ts`
suspends the Mac renderer. Detaching returns to the same Mac Inbox.
`d` forwards the normal `wt rm` command after confirmation, preserving the
remote installation's lock and dirty-work safeguards while explicitly leaving
any SST stage intact.

## Modal UX rules

Every list-picker modal follows the same shape so muscle memory carries across pickers — and the shape is now CODE, not convention: `tui/modal-keys/list-picker.ts` (`handleListPickerKey`) implements move/digits/chords/confirm/cancel once, and every picker handler delegates to it after its picker-specific pre-checks (text-input modes, space-toggle, preview-on-move). Add new pickers through it; hand-rolling the base keys is how pickers drift. The rules it encodes:

- **Trigger-key re-press confirms.** Whatever key opens the picker (`l`, `;`, `'`, `!`, `M`, `v`, `b`, `u`, `y`, `Shift+F12`) also commits the highlighted row when pressed again (`l l`, `; ;`, `' '`, `! !`, `M M`, `v v`, `u u`, `y y`) — the `confirm` option. Shifted-letter triggers work through `matchesTrigger`'s `isShiftedLetter` leg (csi-u never delivers the uppercase literal in `sequence`).
- **Enter still works** — the chord is the cheap path, Enter the discoverable one.
- **Esc / q / Ctrl+C cancel.** Universal, no exceptions.
- **j/k or arrows move.** Nothing fancier; `g`/`G` aren't bound inside pickers.
- **1–9 quick-pick** when the list shows ≤9 items; out-of-range digits are ignored. Pickers whose rows have their own letters (actions) or where digits would be ambiguous (multi-select) pass `digits: false`; pickers with special rows remap via a `digits` function. When digits are live, the hint bar says so (`1-9 quick pick`) — working-but-invisible keys are how the convention stopped being one.
- **Per-item letter chords where rows are nameable** (`chords` option): the status picker's `t/w/r/n/h/y` states, per-harness `c/x/o` "new session" rows. Render the letter dim in the row (`PickerModal`'s `itemKeys`) so the chord is discoverable.
- **Sub-affordances get their own letter** (`l n` new section, `! c` custom prompt, `; c` new claude session). The trigger re-press always means "confirm the highlight", never "jump to the special row".
- **Live preview on the bottom pane when it helps** (outputs, sessions) via `previewFocusPatch` from `tui/picker-preview.ts`; pickers without a sensible preview leave the pane alone.
- **`x` kills** where rows represent killable things — DIRECTLY, no confirm: reaching the row already took two deliberate steps (`;`, navigate), and the kill is narrated on the event feed. Only the Shift+F10/F11 shell/diff kills route through `killSessionConfirm` (single-chord openers with no picker in between). Forgetting a dead ghost is likewise immediate — there's nothing to lose.
- **Confirm modals cancel on their opening key.** `handleYesNoKey`'s `extraCancelKeys` carries the opener (`d`, `c`, `e`, `E`, `w`, `!`) so the muscle-memory toggle works on the destructive path too. Openers that aren't a single bare key (Ctrl+R, Shift+F10/F11, Enter) keep just the universal cancels.
- **Hints reflect the chord** — render the trigger-confirm pair in the modal's `hints`; `PickerModal` / `MultiPickerModal` take a `toggleKey` prop that wires this.
- **Unbounded lists scroll, don't clip.** The `Modal` shell clips overflow with no scrollback of its own, so any list that maps user-sized data (actions, sessions, branches, outputs, clean candidates) wraps its rows in `<ScrollableList>` (`tui/panels/scroll-list.tsx`): it fills the modal, suppresses the mount scrollbar flash, and scrolls the selected row into view as j/k moves (each row carries a stable `id`, and `selectedId` names the highlighted one). Rows still own horizontal truncation (`wrapMode="none" truncate` inside a `flexGrow`/`overflow="hidden"` box) — vertical scroll, horizontal ellipsis.
- **Modals size to their content.** The `Modal` shell grows with its children up to the inset-derived height cap — a seven-row picker is a seven-row modal. `fill` opts back into the full fixed frame for content that owns the space (help) — a bare `flexGrow` scrollbox doesn't self-measure and collapses under auto-height, which is also why `ScrollableList`-based pickers work unchanged. Hint chips along the bottom edge wrap BETWEEN hints at narrow widths (`KeyHint` renders each pair as one non-wrapping `<text>` inside a `flexWrap` row) — never through the border.
- **Row columns must clip, not shrink.** Two safe shapes: a single `<text wrapMode="none" truncate>` composing columns with spans + `padEnd`, or (for label+value rows like yank's) a `flexShrink={0}` box around the fixed prefix plus a `flexShrink={1} overflow="hidden"` box around the value — the `row-cell.tsx` pattern. What garbles is anything else: bare `<text>` flex siblings shrink under width pressure (columns misalign) or overprint the pane behind (the old yank modal bleed at narrow widths).

When a picker doesn't naturally have a single trigger key (e.g. branchPicker, reached mid-flow), drop the re-press leg and keep Enter/Esc — don't invent a trigger key to satisfy the rule.

## Work status

`core/work-status.ts` is the pure module behind `wt status` / the `u` picker: the fixed six-state vocabulary, prefix resolution, urgency ranking, and the one derived override (`effectiveWorkState`: a session waiting on input renders as needs-human whatever was asserted). The record itself (`{state, note?, risk?, at, sha?}`) lives in `WtSlugState.work` — so persistence, cross-process propagation (the state-file watcher), remote transport (`wt ls --json` → `remoteWorktreesQuery`), and TUI freshness were all already wired. The rules that make agent assertions trustworthy (ready needs `--risk`, needs-human needs a note) are enforced in `cli/commands/status.ts`, deliberately NOT in the setter — the TUI picker stays lenient for the human. Consumers: `workStatusBadge` (badges.ts) renders the dot, `rowWorkRank`/`sortActiveRows` (useWorktreeRows.ts) drive the `[ui] sort = "status"` ordering, `rows/status.tsx` is the details row, and `useWorkStatusEvents` narrates observed transitions into the attention feed.

## Logging

`src/core/logger.ts` gives every source three channels: file-only `debug/info/warn/error(msg, ctx?)`; `event.{info,ok,warn,err,dim}(text, opts?)` which fans out to the file *and* the bottom pane's firehose feed (when the TUI runtime has registered a sink); and `attention.{info,ok,warn,err}(text, opts?)` for the curated attention feed — the pane's default view, reserved for things worth interrupting a scan for (work-status transitions, needs-you signals; `event.err` lines surface there too by level). Lazy daily file at `~/.cache/wt/logs/app/wt-YYYY-MM-DD.log`, 14-day retention, cross-process append-safe. `tui/activity-log.ts` is just the in-memory store + `useEvents` hook — emit through `createLogger(...)`.

**Toasts** (`tui/toast.ts`) are the footer's transient one-liner: a single latest-wins slot, colored by level, auto-expiring. Two producers, per the contract in CLAUDE.md: keystroke feedback goes through the flows' `ctx.toast(message, color?, ms?)` (a wrapper over `showToast` — toast-only, never logged), and background code toasts through the logger — `attention.*` emits toast by default (`{toast: false}` opts out), `event.*` emits opt in with `{toast: true}`. The logger side is `setToastSink`, registered by `attachLoggerToasts()` in `tui/runtime.tsx`; CLI runs have no sink, so the flags are inert there.

Per-worktree destroy logs live one level up at `~/.cache/wt/logs/<slug>-*.log`; `wt logs <slug>` tails the latest. Event lines in the daily file are tagged `EVENT` (firehose) or `ATTN` (attention), so `grep ' EVENT \| ATTN '` reconstructs what the pane showed.

## Stable files

These define contracts; touching them ripples. Read them first:

- `src/core/config.ts` — schema, defaults, validation ([reference](configuration.md)). The user config is recursively overlaid by the nearest `.wt.toml`; arrays replace whole, and `WT_REPO_CONFIG` preserves selection across child processes. Fail-fast loader, one aggregated error. Optional sections (`sst`, `issueTracker`, `devServer`, `ai`) are `null` when absent; `reviewBot` is always present (CodeRabbit preset when `[review_bot]` is omitted); `requireSst()` is the typed boundary for SST-only paths. Pure discovery/merge helpers live in `src/core/config-layer.ts`.
- `src/tui/rows/types.ts` — the `RowModule` contract; `src/tui/rows/index.ts` — the registry.
- `src/tui/hooks/useWorktreeRows.ts` — per-worktree field aggregator (`FieldState<T>` carries `error`).
- `src/core/diff/` — graceful-degradation diff compactor for the AI pipeline (`parts.ts` parses, `render.ts` transforms per mode, `fit.ts` runs the priority-aware greedy reducer). Cache keys are SHA-256 prefixes of the *unfiltered* diff so filter tweaks don't invalidate prior summaries.
- `src/core/ai.ts` — OpenAI-compatible / Gemini client returning `{title, brief, description}` from a line-prefixed response, with a lenient parser.
- `src/core/logger.ts` — see above.
