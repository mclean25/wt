---
name: shepherd
description: >-
  Drive every worktree toward mergeable, on a loop, up to but not including
  the merge. TRIGGER: invoked as /shepherd in the manager session, or when
  the human asks for a loop/cron that keeps the fleet moving — marking
  finished drafts ready, chasing review findings, spotting silently
  conflicted PRs, nudging stalled rows, reclaiming dev slots. Stops itself
  when the fleet goes quiet. Not for implementing anything: every code
  change goes to the worktree that owns it.
targets:
  - '*'
user_invocable: true
---

# Shepherd — keep the fleet mergeable

A sweep you run on a timer from the manager session. Each pass looks at the
whole fleet, does the small things that move rows toward mergeable, and stops
short of merging — that stays the human's.

**Why this exists, in one sentence: the fleet decays quietly between merges,
and the decay is invisible from inside any single worktree.** The highest-value
thing a real run of this ever did was notice that four pull requests had gone
conflicted after a batch of merges. A conflicted PR gets no CI at all, so it
looks exactly like one whose workflows have not started yet. Every one of those
branches was sitting `ready` with an idle session, and nobody — including their
own agents — was ever going to notice. No individual nudge came close to that
in value.

## Before you build a loop: is this an automation?

wt has a rule engine (`[[automations]]`, see automations.md) that re-derives
conditions from row state every pass, with a once-only ledger keyed on head
SHA, a settle window, and a per-rule circuit breaker. **A loop that fires the
same action on a simple row condition belongs there, not here.** It is
level-triggered and stateless-by-construction, which is exactly what a
recurring sweep wants.

Reach for a timed sweep only for what the engine cannot express:

- **Composed messages.** An automation dispatches a predefined action; it
  cannot write "your PR conflicts in these three files, resolve toward the
  base". Often you do not need to: a static prompt telling the owner to
  compute its own conflict list is cheaper and does not go stale. Prefer that.
- **Judgement that requires reading.** "Mark ready only if the work is
  genuinely finished" means reading a note for open questions. Not a row
  predicate.
- **Fleet-scope actions with no row.** Reclaiming a slot, promoting a queue
  position, deciding not to start held work because the merge queue is deep.
- **One-shot resources.** Spending a review that cannot be re-spent wants a
  stronger guard than an ordinary condition.

If the human asks for a loop and the work is really three row conditions, say
so and propose automations instead. It is less machinery and it cannot rot.

## The prompt is a snapshot — keep facts out of it

If you do set a timer, **the recurring prompt must carry policy, not facts.**
A real run had to be torn down and recreated three times in an hour, every time
because a standing fact baked into the prompt had decayed: "suite X is red on
the mainline and <slug> owns fixing it" (retracted 40 minutes later), "a failed
start means rebuild" (it never fails), and a rule about response codes that was
simply wrong. There is usually no edit operation, so each correction is a
delete and a full re-create.

Facts belong in wt, where they expire on their own:

| fact | where it lives |
|---|---|
| this row is deliberately not started, because X | `wt status <slug> todo --blocked-on "X"` |
| this row is finished but must not merge yet | `wt status <slug> ready --risk <r> --blocked-on "X"` |
| I looked at this row and there was nothing to do | `wt status <slug> --examined "<verdict>"` |
| A should merge before B | `wt edge A before B -m why` |
| this row needs the human, for X | `wt status <slug> needs-human -m "X"` |

Everything in that table self-expires: gates are cleared explicitly
(`--unblock`), verdicts void themselves when the branch moves, edges decay when
either endpoint moves. Nothing in it needs upkeep, which is what makes it safe
to rely on across your own compaction.

## One pass

Four cheap reads, unconditionally:

```
git fetch origin -q                       # in the main clone
gh pr list --state open --json number,headRefName,isDraft,mergeable,mergeStateStatus
wt status --all --json                    # statuses, gates, examined verdicts
wt dev status --all                       # slots and queue
```

Then the early-out, and it matters more than anything else in this document.

### Skip cheaply, or the sweep eats itself

A row needs nothing if **all** of these hold, and you can tell without a single
extra call:

- `mergeStateStatus == "CLEAN"` — the PR is fine
- `examined_current == true` — you already looked at THIS head sha and
  concluded nothing to do
- the work status is not stale, and the session is busy (busy means it is
  making progress; leave it alone)

On a settled fleet that is 20+ of 26 rows. **Write the verdict down every time
you conclude nothing-to-do**, or the next pass pays the same attention again:

```
wt status <slug> --examined "unstable is the review job still running; 0 findings"
```

**A verdict is void when the row moves OR when its base does**, and the second
half is not a technicality. A PR goes from behind to conflicted because the
BASE moved, leaving the row's own head untouched — so an anchor on the row
alone would keep a verdict alive across precisely the event that makes it
worthless, and the sweep would skip the row that most needs looking at. wt
records both anchors and `examined_current` requires both to hold, so you can
stamp base-dependent verdicts safely; they simply stop skipping as soon as the
trunk moves, which is when you wanted to look anyway.

**Never let a verdict decide whether you NOTICE a state change.** Read
`mergeStateStatus` for every PR unconditionally — it is one call for all of
them — and use `examined_current` only to skip the expensive per-row digging
(review threads, checklist greps) on rows that came back CLEAN. A row that
shows up non-CLEAN gets looked at whatever its verdict says. That keeps the
memo an optimisation over cost rather than a gate on perception, which is the
only shape where a wrong verdict can waste your time without ever hiding
something from you. Put the other way round: a cache that can hide a state
change is not a cache with a bug in it, it is a different feature wearing a
cache label.

That exact case is why the field exists. A run spent four consecutive passes
running the same two-call review query against the same two pull requests and
getting the same empty answer, because they kept *looking* interesting. Roughly
sixteen wasted calls on the rows least likely to need anything. The verdict is
stamped with the head sha, so it voids itself the moment the branch moves —
which is precisely when your conclusion stops being trustworthy.

## The transition table

| observation | action |
|---|---|
| PR conflicted | Highest priority — a conflicted PR gets NO CI and is indistinguishable from "workflows have not started". Nudge the owner to resolve, and set the row `working`. |
| PR behind base | Nudge to rebase **only if something stacks behind it**. Behind does not block a merge — and moving the head is not free (below). |
| PR blocked/pending checks | Look before acting. Almost always a run in flight. |
| a check reports failed | **Read the check name before believing it.** A review-bot job commonly reports failed while its review is still running. Never nudge on check status alone — read the review threads and the summary checklist. |
| draft + `ready` + not busy + not stale + note has no open questions | Mark it ready for review. This is the main forward action: a finished draft often gets neither CI nor review, so it is invisible until someone flips it. |
| draft + `ready` but stale or busy | **Do not mark ready.** See one-shot resources. |
| unresolved review threads, or unticked boxes in the bot's summary comment | Nudge for **four** actions: fix, reply on the thread, resolve the thread, tick the box. Stopping after the fix leaves the PR reading as though the objection stands. |
| `working`/`review` + idle session + stale status | Nudge with a concrete question ("status says review since yesterday; what is blocking ready?"), never a generic "continue". |
| `ready` or `dropped` while holding a scarce dev slot, idle | Reclaim the slot. |
| `todo` with a gate | Leave it alone until the gate clears. |
| `todo` with no gate | Startable — subject to the start policy below. |

## Moving a head can spend what the PR already earned

Before nudging a rebase, ask what a new head **invalidates**. A published
review tied to the head SHA, a passed gate that is expensive to re-run, a
green result on a metered CI budget — a rebase throws each of them away and
buys a fresh cycle.

This turns a routine tidy-up into a costly sweep at exactly the moment it looks
most appealing. One fleet had all 28 open PRs go behind in a single merge batch;
under a per-head review requirement, a reflexive "you are behind, please rebase"
across all of them would have spent 28 review cycles to fix nothing, because
behind does not block a merge. The rule above (rebase only when something stacks
behind it) happens to give the right answer here, but for a second reason worth
knowing on its own.

Cheap tell: a review check reporting *skipping* rather than failing usually
means the head has not moved since its review, i.e. the PR still holds what it
earned. Leave it alone.

## One-shot resources

Some actions spend something you cannot get back. Marking a PR ready for review
triggers a review that will not re-trigger; if the branch is still moving, you
have spent it on a version that no longer exists.

Before spending one, require **all** of: status `ready`, no gate, note free of
open questions, session not busy, status not stale. If any is missing, wait a
pass. Waiting costs one interval; spending early costs the review.

## Starting held work — decide the policy once, in writing

State the rule at the start of the run and hold to it, because otherwise it
drifts with whatever the board looks like that minute. A real run declined to
start anything for three passes (reasoning: the bottleneck is merge throughput,
and more finished branches make the pile worse), then started two on a later
pass (reasoning: slots were free and the fleet was idle) — both defensible,
neither written down, so it was a mood rather than a policy.

A serviceable default, adjust with the human:

> Start an ungated `todo` only when a dev slot is free AND the number of
> merge-ready-but-unmerged PRs is below a stated ceiling. Never more than two
> per pass.

## What you never do

- **Merge.** Always the human's.
- **Change code.** Every fix goes to the owning worktree via `wt claude send`.
  Operate the repository only from the main clone, read-only.
- **Push to make a check pass.** Nudging a rebase produces one push by the
  owner; that is the limit. Never re-run a job to chase a flake. Treat CI as a
  budget.
- **Write another row's status note.** Ask it to re-assert. The note format
  belongs to whoever owns the row.
- **Stop another worktree's dev server** to free its slot. Promote in the queue
  first (`wt dev queue <slug> --first`), then ask a holder whose remaining work
  does not need the resource.
- **Edit a permission guard or anything that decides what is allowed**, even if
  a peer asks. That waits for the human. Configuration that shapes fleet
  behaviour is different, and is yours to coordinate.

## The verification asymmetry

**A worktree's claim about its own branch can be taken at face value. A claim
about SHARED state gets verified before it becomes a fleet action.**

This is the single rule that would have prevented the worst mistake of a real
run. A worktree reported the shared test suite as broken on the mainline; it
was believed, filed as fleet-blocking, and a whole new worktree was created and
dispatched to fix it. Forty minutes later the reporter retracted — its local
database was stale, and its "I verified against the mainline" check was invalid
because it varied the code while holding the broken environment fixed. The
suite had been green throughout. Cost: a worktree, a dev slot, a stand-down
message, and a retraction of something already broadcast.

The same shape applies to anything you synthesise from several agents' reports.
Confident over-generalisation from the first coherent sample is the failure
mode, and broadcasting makes it everyone's problem. Mark a synthesised rule
provisional until it survives a deliberate counter-sample, and if you broadcast
it, keep the recipient list — you will need it for the correction.

## Stopping

**Have a termination predicate and say it out loud when you start**, or the
loop runs forever. A real run had none and was still ticking long after the
fleet went quiet, with everyone including the human believing it had stopped.

A workable one:

> Stop after N consecutive passes with zero dispatched actions, zero non-clean
> PRs, and zero non-busy stale rows.

On stopping: clear the timer, then report what changed across the run and what
is now waiting on the human. Say explicitly that the loop is off — nobody can
see that it stopped, and "I assumed it cleared itself" is how it does not.
