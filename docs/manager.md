# The manager session

A singleton fleet-coordinator session: one persistent AI harness conversation whose job is the *fleet*, not any single worktree — triage what needs the human, nudge stalled worktree agents, plan merge order, answer fleet-level questions from workers. It complements the [work-status](cli.md#wt-status-slug-state--m-note---risk-r) system: statuses answer "what needs me" at a glance; the manager is for the judgment work above that.

Deliberately thin: wt ships no manager-specific engine. The manager is an ordinary session slot (like the `,` / `.` / `/` slots) named `manager`, running in the main clone, whose *role* comes from its playbook (a skill in your harness config) plus the things wt points at it.

One identity subtlety: the manager shares the main clone's directory with the `.` slot, and Claude's primary-conversation UUID is derived from the directory — so the manager lives as a **named** claude session (`manager~manager` in tmux) with its own deterministic conversation. All the entry points below carry that name automatically; a leftover primary-form `manager` session from before this scheme is killed once at TUI startup (it was literally the same conversation as `.`).

## Entry points

- **`m`** in the TUI attaches it (F12 detaches back), creating it on first use with the Shift+TAB-selected primary harness.
- **`M`** opens the [command palette](#the-command-palette-m) — push a canned play (or free text) into the manager without attaching. (Auto-merge, which once lived on `M`, is now the `! m` picker row.)
- **`wt manager`** attaches from a shell; **`wt manager send <text…>`** injects a message (cold-starting the session detached if needed) — the fire-and-forget outbound channel for worktree agents (`wt manager send "who owns the shared migration ordering?"`) and scripts. Workers use it for fleet-level questions and for **papercuts** (`wt manager send "papercut: ..."`); nothing is returned either way, so a papercut costs the worker one line and never parks its branch in `needs-human`.
- **`[[actions]]` with `target = "manager"`** inject their rendered prompt into the manager instead of the worktree's session, prefixed `[re: <slug>]` so the subject is explicit. Combined with [automations](automations.md), that's how wt briefs the manager hands-free:

```toml
[[actions]]
id     = "brief-manager-needs-human"
name   = "Brief manager: needs human"
prompt = "{{slug}} asserted needs-human. Read `wt status {{slug}}`, triage: if you can unblock it yourself (gh operations, fleet knowledge), do so and set the next status on its behalf; otherwise summarize what the human must do."
target = "manager"

[[automations]]
id  = "manager-triage-needs-human"
on  = "status.needs_human"
run = "brief-manager-needs-human"
```

Manager briefings (like `builtin:notify`) bypass the automation quiescence gate — they don't touch the worktree, and the interesting fires happen exactly while the worktree's session is busy.

## The command palette (`M`)

`M` opens a picker of manager plays, built from the same two-screen machinery as the `!` action picker (letter quick-picks, an extras screen before launch, `M` re-press / Enter confirms). Builtins, in order:

| key | command | what it asks for |
|---|---|---|
| `d` | Digest: what needs me | ≤5 bullets — what needs the human now, what's mergeable in what order, what's stalled |
| `t` | Triage needs-human rows | unblock what it can itself, re-assert statuses, distill the remainder to one ask per row |
| `o` | Plan merge order | concrete order + conflict risks + forced restacks |
| `n` | Nudge stalled workers | pointed `wt claude send` to quiet working/review rows |
| `a` | Audit work statuses | cross-check every assertion against PR/CI/session reality, fix drifted records |
| `s` | Start next todo | pick the highest-value `todo` row(s) and kick their agents off |
| `r` | Ask about selected row | free text about the list-pane selection, delivered `[re: <slug>]` |
| `m` | Compact manager context | raw `/compact`, sent directly (no extras screen) |
| `c` | Custom message… | free text to the manager, fleet-scoped |

Fleet-scoped commands (`d`/`t`/`o`/`n`/`a`/`s` and custom text) inject with no row context and no `[re:]` prefix. The row-scoped entries (`r`, plus any of your `[[actions]]` with `target = "manager"`, which also appear in the palette) launch against the row selected when the palette opened — grayed out when there isn't one.

**Reporting back.** Every fleet builtin's prompt ends with the same contract: finish by running

```
wt manager report [--ok|--warn|--err] "<one or two lines>"
```

The report lands on the TUI's **attention feed** (source `manager`, with a toast) via a watched spool file — so the human sees the outcome of a palette command without attaching, and a missed toast is still in the pane record. Reports written while no TUI is running are not replayed at the next boot (stale triage isn't news); the daily log keeps the durable copy of everything that surfaced.

**Context %.** The footer shows the manager conversation's context occupancy immediately left of `[m]` (from the session tail's per-turn usage; dim, warn ≥70%, red ≥85%). Claude auto-compacts in the low 90s, so red means "run `M m` now, on your terms". The number appears once a live manager claude session has produced a turn.

## The manager's toolbox

Everything is ordinary CLI surface, so any harness can drive it:

- `wt fleet --json` — **the primary sense**: one audit command joining each worktree's asserted status with reality — session liveness (`busy`/`last_activity`) and PR truth (number, draft, merge state, mergeability, CI rollup) — from a single batched GitHub query, recently-removed rows appended ([cli.md](cli.md#wt-fleet)). Merge fields read `"computing"` while GitHub lazily calculates; re-run, never poll.
- `wt status --all --json` — the status-only view (state, risk, note, staleness per worktree), plus recently-removed rows (`kind: "merged"|"removed"`, ≤48h) so an all-merged fleet doesn't read as an empty one.
- `wt status <slug> <state> …` — assert on a worktree's behalf after acting on it (`--note-only` sharpens a note without touching state or timestamp).
- `wt claude send <slug> "<text>"` — nudge a worktree's live session (also accepts the `wt`/`main`/`dotfiles`/`manager` repo-level slugs; an archived slug answers with why it's gone).
- `wt claude ls --json` — live sessions with `busy` / `last_activity` per session.
- `wt manager report [--ok|--warn|--err] "<text>"` — surface a terse result on the TUI's attention feed (the palette's report-back channel).
- `gh` — PR state, merges (only when the human asked), CI.
- Cross-session messaging, when the harness supports it — see below.

### Session names are addresses

Every Claude session wt spawns is named after its wt identity: `<slug>` for a worktree's primary session, `<slug>~<name>` for a named one, the slot label for the `wt` / `main` / `dotfiles` / `manager` slots. That name is the `/resume` label, the process registry's `name`, and — the reason it's slug-derived rather than a generic `primary` — **the address peer Claude instances reach the session by**. An agent that can list its peers can therefore map a row straight back to a worktree, and message it without going through tmux at all.

wt does not implement that transport, and shouldn't: it guarantees the names, nothing more. Direct messaging only reaches a session that is **already live**, only works for Claude, and delivers text into a conversation rather than typed input — so it cannot cold-start a stopped worktree, cannot invoke a slash command, and cannot carry wt's own traffic (automations, briefings, `[[actions]]`) since wt is a Bun process, not a Claude instance. Those all stay on tmux injection, which boots what it needs to and pastes as though the human typed it:

- `wt claude send <slug>` / `wt manager send` — work whether or not the target is running, and the `!` menu's custom actions deliberately act like keystrokes.
- Worker → manager escalations and papercuts stay on `wt manager send` for exactly this reason: fire-and-forget with a cold start beats "list peers, find the manager, handle it being down".

An agent nudging a peer it can see live may use direct messaging and skip the paste machinery; anything that must arrive regardless of the target's state uses wt.

## Feedback channel (opt-in)

With `[manager] wt_feedback = true` ([configuration.md](configuration.md#manager)), the manager's playbook includes a standing brief to proactively send workflow papercuts and missing-sense observations from fleet work to the session working on the wt source repo, which reviews and applies what's warranted. Off by default — it presumes you run such a session.

## Lifecycle

The session survives wt restarts by construction (it lives on the wt tmux server) and is whitelisted from the orphan reaper like the other slots. It is not auto-spawned at boot: the first `m` / `wt manager` / injection creates it. Keep its context lean — the playbook should mandate terse replies and periodic `/compact`; the durable fleet state lives in wt (statuses, PRs), never in the manager's conversation.
