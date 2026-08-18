# The manager session

A singleton fleet-coordinator session: one persistent AI harness conversation whose job is the *fleet*, not any single worktree — triage what needs the human, nudge stalled worktree agents, plan merge order, answer fleet-level questions from workers. It complements the [work-status](cli.md#wt-status-slug-state--m-note---risk-r) system: statuses answer "what needs me" at a glance; the manager is for the judgment work above that.

Deliberately thin: wt ships no manager-specific engine. The manager is an ordinary session slot (like the `,` / `.` / `/` slots) named `manager`, running in the main clone, whose *role* comes from its playbook (a skill in your harness config) plus the things wt points at it.

One identity subtlety: the manager shares the main clone's directory with the `.` slot, and Claude's primary-conversation UUID is derived from the directory — so the manager lives as a **named** claude session (`manager~manager` in tmux) with its own deterministic conversation. All the entry points below carry that name automatically; a leftover primary-form `manager` session from before this scheme is killed once at TUI startup (it was literally the same conversation as `.`).

## Entry points

- **`m`** in the TUI attaches it (F12 detaches back), creating it on first use with the Shift+TAB-selected primary harness.
- **`M`** opens the [command palette](#the-command-palette-m) — push a canned play (or free text) into the manager without attaching. (Auto-merge, which once lived on `M`, is now the `! m` picker row.)
- **`wt manager`** attaches from a shell; **`wt manager send <text…>`** sends a message, cold-starting the session detached if needed. It is the single outbound channel for worktree agents and scripts, and it stamps the sending worktree's slug on the message automatically.
- **`[[actions]]` with `target = "manager"`** send their rendered prompt to the manager instead of the worktree's session, prefixed `[re: <slug>]` so the subject is explicit. Combined with [automations](automations.md), that's how wt briefs the manager hands-free:

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

They also never fire on the manager's *own* status writes. Triage ends by sharpening the `needs-human` note, which re-asserts the state and would otherwise brief the manager about itself; the work-status record stamps who asserted it (`by`) precisely so the engine can tell an escalation from an echo. Details in [automations.md](automations.md#a-briefing-never-echoes-its-own-audience).

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

Fleet-scoped commands (`d`/`t`/`o`/`n`/`a`/`s` and custom text) send with no row context and no `[re:]` prefix. The row-scoped entries (`r`, plus any of your `[[actions]]` with `target = "manager"`, which also appear in the palette) launch against the row selected when the palette opened — grayed out when there isn't one.

**Reporting back.** Every fleet builtin's prompt ends with the same contract: finish by running

```
wt manager report [--ok|--warn|--err] "<one or two lines>"
```

The report lands on the TUI's **attention feed** (source `manager`, with a toast) via a watched spool file — so the human sees the outcome of a palette command without attaching, and a missed toast is still in the pane record. Reports written while no TUI is running are not replayed at the next boot (stale triage isn't news); the daily log keeps the durable copy of everything that surfaced.

**Context %.** The footer shows the manager conversation's context occupancy immediately left of `[m]` (from the session tail's per-turn usage; dim, warn ≥70%, red ≥85%). Claude auto-compacts in the low 90s, so red means "run `M m` now, on your terms". The number appears once a live manager claude session has produced a turn.

## The manager's toolbox

Everything is ordinary CLI surface, so any harness can drive it:

- `wt fleet --json` — **the primary sense**: one audit command joining each worktree's asserted status with reality — session liveness (`busy`/`last_activity`) and PR truth (number, draft, merge state, mergeability, CI rollup) — from a single batched GitHub query, recently-removed rows appended ([cli.md](cli.md#wt-fleet)). Rows also carry `section`, the human's manual TUI grouping — treat a name like "Merge after Release" as asserted merge-ordering intent, on par with a status note. `work.by` names who asserted the status: the worktree's own slug normally, `manager` when triage did, `null` for the human — which is how "already triaged" is readable at all. Note the path: nested `.work.by` here, flat `.by` on `wt status --all --json`, and a query against the wrong one answers `null` — the same `null` that means "unattributed". Merge fields read `"computing"` while GitHub lazily calculates; re-run, never poll.
- `wt status --all --json` — the status-only view (state, risk, note, staleness per worktree), plus recently-removed rows (≤48h) so an all-merged fleet doesn't read as an empty one. `kind` discriminates on all three appending surfaces (this one, `wt fleet --json`, `wt ls --json`) with the same values: `"live"` for worktrees that exist, `"merged"`/`"removed"` for history, and only live rows carry `state`/`risk`/`note`. Filter on the value rather than counting rows against `wt section ls` or `wt doctor` — those list live worktrees only, so they legitimately disagree, and reading that gap as a failed prune costs a cross-check every time.
- `wt status <slug> <state> …` — assert on a worktree's behalf after acting on it (`--note-only` sharpens a note without touching state or timestamp).
- `wt edge <from> <before|conflicts|enables> <to> [--blocks|--prefer] [-m why]` — record merge sequencing as structured state instead of prose ([cli.md](cli.md#wt-edge-from-kind-to)); `wt edge --json` reads it back with staleness computed. Edges self-expire when either branch moves — re-assert what still matters, never audit the list. Worktrees assert their own first-hand dependencies; cross-branch edges are yours to assert.
- `wt claude send <slug> "<text>"` — ensure and nudge a worktree session (also accepts the `wt`/`main`/`dotfiles`/`manager` repo-level slugs; an archived slug answers with why it is gone). Delivery is confirmed against the target transcript; a non-zero exit means the message is not in that conversation. A payload that IS a slash command (`/compact`, a bare `/context`) runs, because submitting at the prompt is exactly what running one requires — but a command leaves no prompt entry behind, so its delivery is reported as unknown rather than confirmed.
- `wt claude ls --json` — live sessions with stable session, process, tmux and activity fields, plus `transport` (`inspector` = wt can submit into it directly; `terminal` = it has to be typed at) and `waiting_for` (what it is blocked on, when it is).
- `wt manager report [--ok|--warn|--err] "<text>"` — surface a terse result on the TUI's attention feed (the palette's report-back channel).
- `gh` — PR state, merges (only when the human asked), CI.

### wt owns session addressing and delivery

Callers address worktrees and repo slots through `wt claude send`, never through a Claude peer name, socket path, or tmux pane. wt maps the canonical cwd and managed name to a stable Claude conversation identity, discovers a live process, and cold-starts it when absent. Tmux remains the process and interactive UI host.

**A cold start that finds a stuck session recycles it rather than failing.** A tmux session can exist with no live Claude process in it (a harness that never came up). tmux refuses a duplicate name, so the start adopts that session, creates nothing, and waits out the registration timeout — and so does every retry, which is why the failure used to be sticky and only `wt claude stop <slug>` cleared it. Now an *adopted* session that still hasn't registered after the full timeout is killed and recreated once, since by then no conversation can be at stake and the concurrent-creator race the adoption path exists for has already lost its whole window. A session this call genuinely created is not recycled: that is the harness failing to start, and recreating it reproduces the failure. Either way the error quotes the pane, which is where a refusing harness explains itself and the only place that says so — the wrapper's `.err` file is empty in every observed instance, and `wt logs` is about destroy logs.

Messages are also **signed**: a send from inside a wt harness session is prefixed with that session's slug (`[eng-1234-thing] …`), from the `WT_AGENT` variable wt stamps at spawn. Agents used to be told to do this by hand, which is the kind of rule that gets forgotten precisely when attribution matters. A slash command is never stamped — a prefix would stop it being a command.

## How a message reaches a session

wt submits the message **at the target session's own prompt**, in its own process. Every Claude session wt starts is launched under `BUN_INSPECT=ws+unix://<cacheRoot>/insp/<tmux name>.sock`, which exposes bun's inspector on a private 0700 socket; delivery connects there, walks the live Ink/React tree to the prompt component, and calls the same `onSubmit` a keypress would.

That gets four things at once:

- **It arrives as an ordinary user turn** — recorded `origin: {kind:"human"}`, `promptSource: "typed"` — not as peer-framed text carrying a "not typed by your user" preamble. That framing was not cosmetic: it made receiving agents stop and re-ask the human for approval on flows the human had already approved, which is the opposite of what a fleet is for.
- **Slash commands run**, because running one is exactly "submitted at the prompt".
- **A draft in the target's input box survives** — it is read, then re-asserted after the submit clears it, caret position included.
- **A busy target queues it** and runs it when the current turn ends, exactly as typing would.

The mechanism is ported from [unseamless-coop](https://github.com/micthiesen/unseamless-coop)'s fleet scripts. Its anchors are structural React props rather than minified names, so they survive Claude Code's minifier churn — but not an arbitrary restructuring. `wt claude selftest` (and the `messaging` banner in `wt doctor`) verifies them and says so out loud.

**Fallback.** If the session has no socket (started outside wt, or before this feature), the socket is stale (the session restarted), or the prompt isn't reachable, wt falls back to typing into the pane — bracketed paste plus the submit keys — and raises an attention line naming which failure it was, because the remedies differ. `WT_INSPECT=off` forces the fallback for A/B-ing a suspected regression.

The cause rides on the send result (`fallback` on a `terminal` result) rather than living only in the log, and one function — `fallbackAdvice` — renders it for both. Two rules hold there:

- **Nothing that merely degraded is reported as broken.** `WT_INSPECT=off` and a harness with no injector at all are fallbacks by construction; they raise no attention line and their advice names no remedy, because nothing is wrong.
- **A machine-level cause is checked before a per-session one is asserted.** "No socket" has a cause that takes out the whole fleet at once: a shim for a harness binary in the PATH shim dir (`<cacheRoot>/shims/`) strips `BUN_INSPECT` from every session at launch, so no session ever binds a socket and restarting one changes nothing. `staleShims()` is the cheap test — deliberately narrowed to those binaries, since the rest of that directory is discovered from PATH and a leftover shim for an uninstalled bun CLI is inert — and both `fallbackAdvice` and the `wt doctor` messaging banner run it before falling back to the age explanation. This is not hypothetical: a `claude` shim removed from the source in `4eda658` survived on disk, and for a day both diagnostics answered "started outside wt, or before this version — restart it" to a failure no restart could fix, 374 times. When one cause explains 100% of sessions, it is not a per-session cause.
- **The advice is never an imperative.** Whoever reads it is usually not the target's owner — an agent messaging a peer, the manager fanning out a briefing — and the target is usually mid-turn, and the message it is attached to was *delivered*. "Restart it from wt to fix" read as an instruction to kill a live conversation to repair something that hadn't failed. Each line states the condition under which direct delivery returns and leaves the restart to whoever owns that session.

Two cases have **no** fallback, because typing would be worse than failing:

- The session is blocked on a human (`waiting`, e.g. a permission prompt): the submit key would answer that dialog, deciding on the human's behalf. Checked before the attempt and re-checked throughout the wait, since a dialog that appears mid-wait looks to the probe exactly like a prompt that hasn't mounted yet.
- The submit was sent and went unacknowledged: closing the socket doesn't cancel it in the target, so typing the same text could double-submit. wt confirms against the transcript instead.

**Confirmation reads back as far as the send, not a fixed number of bytes.** The match is bounded in time (nothing older than the send counts), so the read has to be too. It wasn't: it reused the 64 KiB summary tail, and on a busy session the landed record scrolls out of that almost immediately — measured at **124ms**, because the next record was a large tool result. wt never resends on its own, so the cost lands on the sender, who is told the message isn't in the transcript and that a resend may duplicate. It duplicates. For a message that asks for an action rather than reporting one, that is a double execution.

**Security.** The inspector socket is an in-process code-execution surface for anything that can open it, and its only access control is the containing directory's `0700` mode (re-asserted on every use, since `mkdir`'s mode applies only at creation). The transport it replaced also required a capability token, so this is a real reduction in defense-in-depth — accepted because bun's inspector protocol has no auth layer to hook, and because anything running as this user can already reach the agent's files and credentials directly. `wt` validates the WebSocket handshake before running anything through it, so a different process squatting the path isn't silently trusted.

## Feedback channel (opt-in)

With `[manager] wt_feedback = true` ([configuration.md](configuration.md#manager)), the manager's playbook includes a standing brief to proactively send workflow papercuts and missing-sense observations from fleet work to the session working on the wt source repo, which reviews and applies what's warranted. Off by default — it presumes you run such a session.

## Lifecycle

The session survives wt restarts by construction (it lives on the wt tmux server) and is whitelisted from the orphan reaper like the other slots. It is not auto-spawned at boot: the first `m` / `wt manager` / send creates it. Keep its context lean. The playbook should mandate terse replies and periodic `/compact`; the durable fleet state lives in wt (statuses, PRs), never in the manager's conversation.
