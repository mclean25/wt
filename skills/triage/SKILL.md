---
name: triage
description: >-
  Triage a pasted batch of tracker tasks into value-vs-testing-burden tiers,
  then optionally materialize the approved batch into ready-to-work git
  worktrees (wt new, prompt.txt briefs, optional GitHub issues), or review
  the state of an in-flight batch. TRIGGER only when the user invokes
  /triage. Free-form argument is the pasted tasks, or a mode hint like
  "review" or "create <which tier>".
targets:
  - '*'
argument-hint: "<pasted tasks: ids + titles/descriptions> | review | create <which tier(s)>"
user_invocable: true
---
# Triage

Turn a pile of tracker tasks into a prioritized batch and then into
ready-to-work worktrees, and report on a batch already in flight. This skill
ends where `/start` begins: it prepares worktrees; `/start` does the
implementation inside each one.

If the tracker isn't queryable from the CLI, tasks arrive as copy-paste: ids
plus whatever title/description text the user pastes. Never invent task
content beyond what was pasted — if a task is too thin to tier, say so and
ask for the description rather than guessing. The human manages tracker
status themselves; never claim to have updated it.

## Project conventions

{{project_notes}}

## Modes

One skill, three modes:

- **triage** (default when given pasted tasks): read every task in the batch,
  tier them by value vs. the human's testing burden, recommend a batch, then
  stop for the user's pick.
- **materialize** (after the user approves a batch): create one worktree per
  group/standalone via `wt new`, write `prompt.txt` briefs, create GitHub
  issues where durable/shared context is warranted, kick off `/start`
  sessions, report.
- **review** (read-only): report the state of an existing batch (statuses,
  worktrees, PRs, review-bot state).

### Picking the mode

1. **Explicit signal in the args** wins: "review" / "status" → review;
   "create" / "go" / "materialize" → materialize; pasted tasks → triage.
2. **Infer from the conversation** when the args are bare: did we already
   triage in this session? are there worktrees in flight?
3. **Ask** (one question) only if it is genuinely ambiguous.

### Read vs. write safety gate (important)

Mode inference is fine for **read** work (triage, review): worst case is the
wrong report. It is NOT fine for **write** work. Never run `wt new` or create
GitHub issues off an inference alone. Always restate the concrete batch
(which tasks, which groupings, which worktrees) and get an explicit go before
materializing.

## Mode: triage

### 1. Absorb the batch

Parse the pasted tasks into (id, title, description) triples. Cross-check
against what's already in flight — `wt ls` for existing worktrees (a slug
carrying the id means it's already being worked), and
`gh pr list --state all --search "<id>"` when a task smells already-done.

### 2. Read the full picture

For each task, check the relevant code area enough to judge scope honestly —
enough to catch duplicates, overlaps, and "this is already implemented". Fan
out subagents over task clusters when the batch is large; faithful summaries
only, and verify any code-level claim that drives a decision yourself.

### 3. Tier by value vs. the human's testing burden

The defining lens: **can this ship without the human manually iterating on
it?** That is the constraint that makes a task delegable.

- **Easy wins** (low burden): UI changes, tightly-scoped deterministic logic,
  config/default flips, bug fixes that are unit-testable.
- **Defer** (high burden): prompt/LLM-guidance changes (require eval
  iteration), large architectural changes, anything needing production
  deploy-gate care.

Call out **duplicates and overlaps** (merge candidates), **dependencies**
(candidates for `--base` stacking), tasks that should be worked as **one
cluster** because they touch the same code, and **design-worthy** tasks that
should go through a design pass before implementation.

### 4. Recommend and stop

Present the tiers compactly, recommend a concrete next batch, and stop. Do
not start materializing until the user picks.

## Mode: materialize

Only after explicit approval, and only after restating the exact batch.

1. **Group.** Decide which tasks share a worktree (same code area, one
   reviewable unit). One worktree per group/standalone.
2. **Worktrees** (see the `wt` skill for conventions; never raw
   `git worktree add`): `wt new <ID> <short title words> --no-open` — id +
   title words mint the branch directly; a second worktree for an in-flight
   id just needs different title words. Use `--base <branch>` for a task
   stacked on another in the batch. A related GitHub issue attaches as the
   SECONDARY id (`--gh <n>` at creation, or `wt issue <slug> --gh <n>`
   later) — never in the branch name. Work with no tracker task gets an
   issue-less worktree (`wt new <some words>`).
3. **GitHub issues — only where they earn their keep.** Create issues for
   multi-part groups that later sessions or other worktrees will need to
   coordinate on, and for design-worthy tasks. Small self-contained fixes
   need no issue — `prompt.txt` carries their context. Reference every
   created issue as `GH: #NNN` in the relevant brief, and record the reverse
   direction in wt: `wt issue <slug> --gh <n>`.
4. **prompt.txt** in each worktree root: the context `/start` would otherwise
   have to rediscover. Its only job is transferring context INTO a different
   worktree's session — never write one for the session you're already in.
   When a GitHub issue holds the spec, the brief is just a pointer to the
   issue. Only when there is no issue does it carry the full context: the
   pasted task text (the canonical copy if the tracker isn't queryable),
   bundled sub-parts and a suggested order, `GH: #NNN` references, utils to
   reuse, "verify the current state first" warnings, overlap notes, and
   dependencies on other in-flight branches. End with: "(You can delete this
   prompt.txt after reading it.)" It must never be committed.

   After writing each brief, seed the worktree's status so the wt list shows
   the batch as queued work: `wt status <slug> todo -m "<one-line goal>"`.
5. **Kick off `/start` in every worktree created** —
   `wt claude send <slug> '/start'` for each, fire-and-forget. Always do
   this; don't offer it or wait to be asked. Sessions run in parallel and the
   human attaches via the wt TUI when they want to watch.
6. **Report**: a table (task(s), branch, path) plus sequencing notes (which
   worktrees are independent, which are stacked or soft-dependent), and
   confirm the `/start` sessions were dispatched.

## Mode: review

Read-only status across the batch:

- `wt status --all` for the asserted lifecycle states (who needs the human,
  what's ready to merge, what's still queued), then `wt ls` and `wt doctor`
  for worktree health (dirty/sync/PR/merged, stuck locks).
- `gh pr list --state all --json number,title,headRefName,state,isDraft,reviewDecision`
  filtered to the batch's branches for a text report; check the review bot's
  findings on open PRs.
- Summarize what is merged / in review / open / in progress, and what is
  next. Report which ids look done/merged so the human can update the
  tracker themselves.

**Don't report worktree cleanup.** The human sweeps merged worktrees
themselves — never volunteer `wt clean` / `wt rm` or list "clean candidates".
Reporting that a worktree's PR is merged is useful; appending "so you can
clean it" is noise. Running them when asked is fine.

## Conventions and gotchas

- **Worktrees**: always via `wt new` (per the `wt` skill); it records fork
  bases, copies env files, and allocates dev-server ports. Slugs are
  kebab-case; the tracker id leads the slug so wt's issue row and review
  tooling can parse it.
- **GitHub text**: full markdown links for issue/PR references; no em dashes
  in anything humans read (issues, PR bodies, comments).
- **Subagents**: use cheap/fast models for the mechanical fan-out reads;
  faithful summaries only.

## User Instructions

$ARGUMENTS
