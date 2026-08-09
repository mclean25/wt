# The manager session

A singleton fleet-coordinator session: one persistent AI harness conversation whose job is the *fleet*, not any single worktree — triage what needs the human, nudge stalled worktree agents, plan merge order, answer fleet-level questions from workers. It complements the [work-status](cli.md#wt-status-slug-state--m-note---risk-r) system: statuses answer "what needs me" at a glance; the manager is for the judgment work above that.

Deliberately thin: wt ships no manager-specific engine. The manager is an ordinary session slot (like the `,` / `.` / `/` slots) named `manager`, running in the main clone, whose *role* comes from its playbook (a skill in your harness config) plus the things wt points at it.

One identity subtlety: the manager shares the main clone's directory with the `.` slot, and Claude's primary-conversation UUID is derived from the directory — so the manager lives as a **named** claude session (`manager~manager` in tmux) with its own deterministic conversation. All the entry points below carry that name automatically; a leftover primary-form `manager` session from before this scheme is killed once at TUI startup (it was literally the same conversation as `.`).

## Entry points

- **`m`** in the TUI attaches it (F12 detaches back), creating it on first use with the Shift+TAB-selected primary harness. Auto-merge moved to `M` to free the key.
- **`wt manager`** attaches from a shell; **`wt manager send <text…>`** injects a message (cold-starting the session detached if needed) — the escalation path for worktree agents (`wt manager send "who owns the shared migration ordering?"`) and scripts.
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

## The manager's toolbox

Everything is ordinary CLI surface, so any harness can drive it:

- `wt status --all --json` — the fleet overview (state, risk, note, staleness per worktree).
- `wt status <slug> <state> …` — assert on a worktree's behalf after acting on it.
- `wt claude send <slug> "<text>"` — nudge a worktree's live session.
- `gh` — PR state, merges (only when the human asked), CI.
- Cross-session messaging, when the harness supports it — worktree sessions and the manager are plain sessions on one machine.

## Lifecycle

The session survives wt restarts by construction (it lives on the wt tmux server) and is whitelisted from the orphan reaper like the other slots. It is not auto-spawned at boot: the first `m` / `wt manager` / injection creates it. Keep its context lean — the playbook should mandate terse replies and periodic `/compact`; the durable fleet state lives in wt (statuses, PRs), never in the manager's conversation.
