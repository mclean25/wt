# Fleet management — why this system exists

The rationale doc. The mechanics live in [cli.md](cli.md#wt-status-slug-state--m-note---risk-r) (`wt status`), [automations.md](automations.md) (triggers, notify), [manager.md](manager.md) (the coordinator session), and [configuration.md](configuration.md#ui) (sort, rows, badges). This page records **the user problem, the design intent, and the agency levels** so future work stays aligned with them. When a change would bend one of these, this is the doc to update deliberately — not drift past.

## The pain

Running ~10 concurrent worktrees, each with its own coding agent, the bottleneck was never the agents' throughput — it was **knowing the state of the fleet**:

- Which worktrees are blocked on *me* right now (a login, a 2FA prompt, a judgment call)?
- Which are built and tested, safe to merge with one keystroke?
- Which are quietly done-ish but were never verified, so "done" can't be trusted?
- Which haven't been started at all?

None of that was visible without opening each session and reading scrollback. Agents routinely ended conversations without saying how safe the result was to merge, or paused to ask the human to do testing they could have driven themselves. Manually curating a "Needs Manual Testing" section by hand was the workaround — the system replaces it.

## What "good" looks like

- **One glance answers "what needs me."** The list pane, top to bottom, IS the priority queue.
- **Interruptions only when a human is genuinely required** — and then loudly (banner), not buried in a log.
- **Zero noise.** A signal that fires when nothing changed, or a note that restates the diff, trains the reader to ignore the channel. Every surface here would rather stay silent than say something low-value.
- **The human does only the human parts**: logins, judgment calls, final say on merges. Everything else is owned end-to-end by an agent.

## The design responses

| pain | response |
|---|---|
| can't see fleet state | the **work-status dot** (leftmost glyph) + the **status-first sort** inside each section — `wt status` / `u`, `[ui] sort` |
| "done" can't be trusted | statuses are made **trustworthy by construction**: `ready` requires a merge-risk level, medium/high risk require a notable-impacts note, `needs-human` requires saying exactly what's needed. The CLI refuses anything less |
| agents end without a verdict | the **ownership conventions** (global CLAUDE.md + /start, /cz-test): never end a task without an asserted status |
| agents punt testing to the human | agents **own manual testing** — dev env + browser themselves; `needs-testing` means "I still have to verify", never "please test this for me" |
| needing-me moments get lost | the **escalation ladder**: dot → attention feed (the bottom pane's default) → macOS banner (`builtin:notify` on `needs_human`/`ready`) → manager triage briefing |
| fleet-level judgment lands on me | the **manager session** (`m`): digests, merge-order calls, unblocking workers, triaging needs-human before the human sees it |

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
- **Never merge a PR.** Never update the external tracker's (Cozee) status.

**The manager** coordinates, and may act autonomously on anything reversible and fleet-scoped:

- Triage `needs-human` briefings: unblock what it can itself (gh operations, answering workers from fleet knowledge, nudging sessions), update statuses on workers' behalf, and distill what genuinely remains into one short ask.
- Nudge stalled workers, plan merge order, produce digests.
- **Never merges** without an explicit ask in its own conversation, and never edits code in a worktree — it delegates to the owning session.

**wt itself** stays deterministic: automations fire once per instance (ledger), notifications only for the two states that mean "look at me" (`needs_human`, `ready` — the human merges manually, so ready IS actionable), and nothing edge-triggered or bespoke.

**The human** keeps: merges, logins/credentials, final QA whenever he wants it, risk acceptance on medium/high `ready`s, Cozee status, and any expansion of the levels above.

## Known deliberate omissions

- `auto-address-codex` (dispatch a fix session whenever the review bot has findings) exists as a commented-out automation — off until the status system has earned trust.
- Statuses cross SSH read-only (`wt ls --json`); no remote automations engine.
- No asserted `done` state: merged/gone is derived and always wins.
