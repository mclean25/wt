# Philosophy — minimal human work

wt's intent doc. The mechanics live in [cli.md](cli.md#wt-status-slug-state--m-note---risk-r) (`wt status`), [automations.md](automations.md) (triggers, notify), [manager.md](manager.md) (the coordinator session), and [configuration.md](configuration.md#ui) (sort, rows, badges). This page records **the philosophy, the user problem, the design intent, and the agency levels** so future work stays aligned with them. When a change would bend one of these, this is the doc to update deliberately — not drift past.

## The principle

**The human does only the work only a human can do.** Everything else — anything agents are good at, anything deterministic code can express — belongs to agents or to wt itself. Concretely:

- Merges, logins/credentials, judgment calls, and risk acceptance stay human. Almost nothing else should.
- If a workflow contains a recurring human step, that's a backlog item, not a fact of life: move it to an agent (a skill, a convention, a manager play) or into wt (a watcher, an automation, a status rule).
- This applies to **every changeset**, not just fleet features. Building anything in wt, ask: what human step does this create or leave behind, and what would it take for an agent or automation to absorb it? Designs that reduce human involvement win ties; designs that add a manual step need to justify it.

The rest of this doc is that principle applied to wt's founding pain: coordinating a fleet of agent-driven worktrees.

## The pain

Running ~10 concurrent worktrees, each with its own coding agent, the bottleneck was never the agents' throughput — it was **knowing the state of the fleet**:

- Which worktrees are blocked on *me* right now (a login, a 2FA prompt, a judgment call)?
- Which are built and tested, safe to merge with one keystroke?
- Which are quietly done-ish but were never verified, so "done" can't be trusted?
- Which haven't been started at all?

None of that was visible without opening each session and reading scrollback. Agents routinely ended conversations without saying how safe the result was to merge, or paused to ask the human to do testing they could have driven themselves. Manually curating a "Needs Manual Testing" section by hand was the workaround — the system replaces it.

## What "good" looks like

- **One glance answers "what needs me."** The list pane, top to bottom, IS the priority queue.
- **The human's queue only ever shrinks.** Agents and automations pull work OFF it (testing, triage, nudging, restacks); nothing wt adds should put new recurring work on it.
- **Interruptions only when a human is genuinely required** — and then loudly (banner), not buried in a log.
- **Zero noise.** A signal that fires when nothing changed, or a note that restates the diff, trains the reader to ignore the channel. Every surface here would rather stay silent than say something low-value.
- **The human does only the human parts**: logins, judgment calls, final say on merges. Everything else is owned end-to-end by an agent.

## The design responses

| pain | response |
|---|---|
| can't see fleet state | the **work-status dot** (leftmost glyph) + the **status-first sort** inside each section — `wt status` / `u`, `[ui] sort` |
| "done" can't be trusted | statuses are made **trustworthy by construction**: `ready` requires a merge-risk level, medium/high risk require a notable-impacts note, `needs-human` requires saying exactly what's needed. The CLI refuses anything less |
| agents end without a verdict | the **ownership conventions** (the wt-managed instructions block + the bundled skills): never end a task without an asserted status |
| agent config drifts per machine/teammate | wt **distributes its own skills + instructions** ([skills.md](skills.md)): startup y/n updates, rulesync/symlink-aware installs, so nobody hand-maintains agent setup |
| agents punt testing to the human | agents **own manual testing** — dev env + browser themselves; `needs-testing` means "I still have to verify", never "please test this for me" |
| needing-me moments get lost | the **escalation ladder**: dot → attention feed (the bottom pane's default) → macOS banner (`builtin:notify` on `needs_human`/`ready`) → manager triage briefing |
| fleet-level judgment lands on me | the **manager session** (`m`): digests, merge-order calls, unblocking workers, triaging needs-human before the human sees it |
| merged rows vanish, so "all landed" reads like "nothing exists" | **recently-merged visibility**: destroyed rows stay on the fleet surfaces for 48h (`wt ls` / `wt status --all --json` append them as `kind: "merged"`; empty states count them: "No active worktrees (2 archived today: …)"), and the merge-cleanup itself lands on the attention feed ("slug merged (#N) — worktree archived"). Derived from the existing removed history — no new store |

Two structural principles underneath:

- **Derive what's derivable; assert only what isn't.** Git/PR/CI/session state is derived live and never stored; the status record holds only what the machine cannot know (intent, verification state, merge risk). Derived urgency (a session stuck asking) overrides the dot's color but is never written into the record, and never reorders the list (sorting on transient signals makes the list twitch).
- **The machinery stays deterministic; the LLM sits on top.** Automations are level + ledger (see automations.md) — the manager and the notify banner are consumers of that engine, not a parallel one.

## Agency levels

The current contract. These are deliberate, not accidental — expanding one (say, letting the manager merge, or auto-dispatching `address-codex`) is a real decision to make here first, not a convenience to slip in. The direction of travel is MORE agency over time, added explicitly.

**Worktree agents** own their task end-to-end:

- Implement, self-review, and **run the manual/browser testing themselves** (dev env, browser-control). Asking the human to test is a failure mode, not a hand-off.
- Assert every lifecycle transition (`wt status`), and never end a session without a clear one. Finishing means `ready --risk <r>` with only *notable* impacts in the note (end users, coworker workflows, cost, irreversibility) — or an honest `needs-testing`/`needs-human`.
- Escalate `needs-human` **only** for genuine blockers: expired logins/creds, judgment calls, human-only checks. Keep working on whatever isn't blocked while waiting.
- Ask fleet-level questions of the manager (`wt manager send`), not the human.
- **Never merge a PR.** Never update the external issue tracker's status.

**The manager** coordinates, and may act autonomously on anything reversible and fleet-scoped:

- Triage `needs-human` briefings: unblock what it can itself (gh operations, answering workers from fleet knowledge, nudging sessions), update statuses on workers' behalf, and distill what genuinely remains into one short ask.
- Nudge stalled workers, plan merge order, produce digests.
- **Never merges** without an explicit ask in its own conversation, and never edits code in a worktree — it delegates to the owning session.

**wt itself** stays deterministic: automations fire once per instance (ledger), notifications only for the two states that mean "look at me" (`needs_human`, `ready` — the human merges manually, so ready IS actionable), and nothing edge-triggered or bespoke.

**Manual delegation triggers** (the pinned `! u` / `! g` builtins, and the `M` [manager palette](manager.md#the-command-palette-m)) sit deliberately between the levels: the HUMAN pulls the trigger, the AGENT does the work. `! u` has the row's agent re-assess and re-assert its own status (the backstop for a record that drifted or was never asserted); `! g` has it continue the task from whatever the status implies. The palette is the same move at fleet scope — digest, triage, merge-order, nudge, audit, start-next-todo are all plays the manager already owns by the contract above; `M` just dispatches them on demand, and `wt manager report` closes the loop on the attention feed so the outcome costs the human a glance, not an attach. `start next todo` is the most agency-forward palette entry (it starts worker sessions), but it stays human-triggered — an automation that starts todos on its own would be a real expansion to decide here first. If any of these fire constantly, something upstream (the always-on status contract, the automations) is failing — treat frequency as a signal, not a workflow.

**The human** keeps: merges, logins/credentials, final QA whenever they want it, risk acceptance on medium/high `ready`s, external-tracker status, and any expansion of the levels above. One deliberate carve-out from "external-tracker status": the post-merge close of a worktree's **attached GitHub issue** is deterministic bookkeeping (the merge already happened — the human's decision is spent), so it belongs to wt via the opt-in `builtin:close-issue` automation, not to the human. The primary tracker's status stays human; agents still never close issues themselves.

## Known deliberate omissions

- `auto-address-codex` (dispatch a fix session whenever the review bot has findings) exists as a commented-out automation — off until the status system has earned trust.
- Statuses cross SSH read-only (`wt ls --json`); no remote automations engine.
- No asserted `done` state: merged/gone is derived and always wins.
