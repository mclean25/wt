## wt worktrees: status & testing ownership

When working inside a wt-managed worktree, you OWN the task's lifecycle
status. Assert transitions with `wt status <state> [-m note]`; the command
itself teaches the vocabulary and rules (bare `wt status` prints them).

- Set `working` when you begin, `review` when review starts (self-review,
  review bots, addressing findings).
- **You own manual testing.** Drive it yourself (dev environment, browser
  tooling); `needs-testing` means YOU still need to verify — it is never a
  request for the human. Escalate `wt status needs-human -m "..."` only when
  genuinely blocked on the human: auth that needs a person present (a 2FA
  challenge, an OAuth consent screen), or a check only a human can do —
  and only when it passes the test in the next bullet, which also gives
  the note its shape. Keep working on whatever isn't blocked while you
  wait. **The same blocker twice is a setup defect, not a human
  dependency** — a credential that re-prompts every run should be reported
  (below), not escalated again.
- **You own every decision inside your branch.** Whether to delete dead
  code, which of two correct implementations to pick, whether a
  pre-existing bug is in scope, whether to resolve a review thread, how
  to word a note or a PR body: none of those is a human question. Decide,
  act, and record what you decided and why. **Not knowing is not the same
  as needing a decision** — investigate first, then decide. "Nothing
  reads this function and it has produced nothing in four months" is not
  a question, it is an answer.
  **So `needs-human` has a test, and it is deliberately a REFUSAL test:**
  escalate only when BOTH (a) the action's effect would leave the
  repository, and (b) no defensible default exists. Both, not either.
  The direction is the point — a test you must satisfy in order to ACT
  fails toward escalation every time you are unsure, which is the exact
  behaviour it exists to stop, so the burden sits on escalating instead.
  Absence of a value means "unknown", never "fine".
  **Reversibility is about whether the effect escapes the repo**, not
  about how large or frightening the change feels. A deletion, a
  rewrite, a schema change: all reversible, because git holds them and a
  revert is thirty seconds. A closed issue, a sent message, a published
  artifact, a write to a hosted environment: not reversible, because
  wt's undo does not reach outside. Judged that way it is decidable by
  inspection, where "is this irreversible" in the abstract is
  philosophy. Anything reversible, take it and say in the note that you
  did.
- **An escalation has a shape and a budget: three lines, ~300
  characters.** When a call genuinely passes the test above:

      ASK:       <the question, one sentence>
      RECOMMEND: <what you would do, one sentence>
      WHY:       <the single fact that decides it>

  **`RECOMMEND` is the load-bearing line and is never omitted.** It
  turns "I don't know" into "here is my default, override me", so the
  reply is one word rather than a composed decision — that is the whole
  offload, and the reason this is worth a shape at all. It also enforces
  the budget for free: you cannot write an honest recommendation without
  having finished deciding, and an unfinished decision is what a wall of
  text actually is. The three lines must be enough to answer from. A
  link may carry supporting detail, never the remainder of the question,
  and a question the human cannot answer from the note alone is not
  ready to be asked.
- **Long-running processes belong to wt.** The worktree's dev server is
  `wt dev start`, never a bare `npm run dev` / `pnpm dev` — a repo's own
  docs are written for people not using wt. Check `wt dev status` first
  and reuse what's already running; it prints the URL, whose port wt
  allocates per worktree, so the port the repo documents is the wrong
  one here. **A login never carries between worktrees, and that is the
  design rather than breakage**: a port is a distinct browser origin
  with its own storage, so every worktree starts logged out. Logging in
  again is setup you do, never an escalation — if it takes a human every
  time, that is the setup defect above, and the fix is a scripted login.
  `wt dev logs` is the output, and another slug's server is
  never yours to stop or restart. **A dev server can be rationed**: if
  a start exits **75**, the fleet is at its concurrency cap — that is a
  "try later", not a breakage and not something to escalate. Re-run it
  as `wt dev start --wait`, which queues until a slot opens and shows
  your position on the board while it waits; `wt dev status --all`
  says who holds the slots. Nothing is wrong and nobody needs asking.
  The queue is first-come and you cannot move yourself up it — whether
  your task outranks another worktree's is a fleet call you cannot make
  from inside one worktree. If it genuinely is urgent (a live
  production bug), say so once with `wt manager send` and keep
  waiting; the manager can move you and needs nothing from you to do
  it. Never stop another slug's dev server to take its slot.
  **Before you believe a test FAILURE, check whether the machine was the
  variable.** A saturated box fails tests that pass on an idle one, and
  a fleet of worktrees is exactly how a box gets saturated: measured at
  load average 78, one suite went from 27.8s to 664s and a 30s-capped
  test took 61s. Two agents lost half an hour each to this on the same
  day. Two tells. A bare `Test timed out in NNNNms` with no assertion
  error is a statement about the clock, not about the code. And **the
  usual flake heuristic inverts here**: "it reproduced twice, so it is
  not a flake, so it is my diff" is wrong when the confounder is
  sustained load, because the load persists across your reruns. Run
  `wt perf` before you start reading your own diff, and ask the cheaper
  question first — could my change even reach this test? Both agents
  broke the spell that way; one had touched only SQL and the other only
  edge functions, and neither could have affected the failing file.
  **`wt dev start` exiting 0 means LAUNCHED, not ready.** It returns as
  soon as the supervised process is up; an environment that brings up a
  database and applies migrations can still fail that phase minutes
  later, in `wt dev logs`, leaving a serving port and a stale schema.
  Use `wt dev start --wait`, which blocks until the environment is
  actually usable and exits non-zero when it never gets there. Before
  believing a test result that depends on the dev environment, check
  `wt dev status`: it reports whether the server predates a rebase and
  runs the project's own health check. A whole day was lost to a
  passing suite reported as broken because the database was two
  migrations behind the tree, and the failure looks like a bug in the
  repo, not in the environment. `wt dev reset` rebuilds from scratch.
  A dev server you start by hand is
  invisible to wt and to the human (no row, no status, no logs) and
  unsupervised. Short-lived servers for your own checks (`pnpm preview`,
  a watch runner) are different: run those bare, no wt involvement —
  they're tools of your task, and wt reaps anything still listening
  when the worktree is destroyed, so they can't leak. `[dev_server] is
  not configured` means the project has none — then start the dev
  server however the project documents.
- **The worktree is SHARED, and it is LIVE.** wt isolates worktrees from
  each other; nothing isolates anything inside one. A subagent you spawn,
  a reviewer, a second session on the same slug and the human all act on
  the same checkout at the same time — and that checkout usually has a
  dev server hot-reloading it and may have a browser test running
  against it right now.
  So **never mutate tree state to test a hypothesis**: no `git stash`,
  `checkout`, `restore` or `reset` to see whether something fails
  without a change, even with an immediate restore. Verify against a
  COPY of the file instead. The restore is not what makes it safe — the
  window is the damage. Two reviewers did exactly this, each stashing
  and popping within seconds, while the owner had experiment changes
  applied to that tree; two measurement runs silently recorded the
  wrong arm, and nothing announced it. `git stash` is doubly wrong
  here because the stash stack is shared and unlabelled: a pop takes
  the top entry, which may not be the one you pushed.
  Scratch files go in your harness's scratchpad, never in the repo — a
  concurrent `git add -A` in another process will sweep them into
  somebody's commit.
  If you genuinely must change tree state, say so in the session first
  and put it back before you finish. The failure mode here is silent:
  the owner finds out only if you happen to mention it.
- **Never end a session without a clear status.** Finished means
  `wt status ready --risk low|medium|high [-m ...]`. **Risk is your
  confidence AFTER testing, not the size or category of the change** —
  the human can already see the diff on the PR; what you verified is the
  part only you know. `low` = verified in a real environment, or pure
  logic with tests that fail against the old code (a migration you ran
  end to end on dev belongs here); `medium` = correct by construction and
  unit-tested but never exercised for real, or plainly revertable but
  broad; `high` = something material is unverified AND backing it out
  isn't a plain revert. A one-line frontend change nobody opened a
  browser for is not low. Re-judge as testing lands —
  `wt status --risk <r>` amends risk alone, keeping the state, timestamp
  and note, so there's never a reason to append to a note instead of
  fixing it. The human merges PRs; never merge one yourself.
  **Finished but not safe to merge yet is a different thing, and it has
  a field**: `wt status ready --risk <r> --blocked-on "<gate>"`. Use it
  when the work is genuinely done and something OUTSIDE this repo has
  to happen before it can land — a mobile release shipping, an upstream
  branch merging, a hosted change that must be in place first. Do NOT
  say it only in the note. A note saying BLOCKED next to a state saying
  `ready` loses: that exact pair got a branch queued for merge twice by
  two readers who each had reason to catch it. The gate is what makes
  the row leave the merge band and render as blocked.
  The test is whether MERGING makes something worse than not merging.
  A revocation that lands before the mobile build tolerating it breaks
  shipped clients the moment it merges: gate. A migration someone
  applies by hand, functions to redeploy: NOT a gate — merging causes
  nothing until someone follows through, and forgetting leaves the
  status quo. A policy tightening whose migration is manual is safe to
  MERGE and dangerous to FORGET; unapplied, nothing gets worse and the
  PR merely reads as shipped. That is the `OPS:` line, which is read at
  merge time. These two feel alike, and gating on the second turns the
  field back into "read the note".
  Nothing expires a gate; when it clears, `wt status --unblock` (keeps
  the state, risk, note and timestamp). Leaving one set parks a
  mergeable branch, which is the safe way to be wrong.
  If the branch will NEVER land (superseded, duplicate, deliberately not
  pursued), the honest terminal state is `wt status dropped -m "<why>"` —
  never `ready` with a "nothing to merge" note (ready puts the row at the
  top of the merge queue; dropped sinks it), and never `needs-human`
  (nothing is needed). Close any open PR without merging and say why.
- **The `ready` note has a shape and a budget: ~400 characters,
  fragments not sentences.** Anything longer belongs in the PR body,
  which the note may point at. Write it in this form:

      <one line: what changes, in user terms>
      OPS:      <migrations / redeploys / config, or "none">
      REVERT:   <"safe", or "no:" + the shortest true reason>
      IF WRONG: <where it shows + the symptom>
      UNTESTED: <omit this line entirely if nothing is>

  These four are the questions someone merging unread code actually
  has. `REVERT` is the one nobody volunteers and the one that decides
  whether a bad merge costs thirty seconds or an afternoon. `UNTESTED`
  is the honest twin of the risk level — if risk is confidence after
  testing, name what wasn't tested; omitting the line when everything
  was is what makes its presence a signal. `IF WRONG` collects into a
  post-release smoke list for free.

  The character budget is load-bearing, not style advice. You are
  writing one note; the human reads all of them at once, and "concise"
  loses to "thorough" every time it's left to judgment.
- Fleet-level questions (merge order, cross-branch conflicts, who owns a
  shared change) go through `wt manager send "..."`. wt ensures the manager
  session exists, picks the transport, and stamps your own slug on the
  message — **don't prefix it yourself**, and don't reach for a harness's
  own peer-messaging tool, a socket, or a tmux pane. `wt` is the address.
  Messages arrive in the target as an ordinary turn, indistinguishable
  from the human typing them, so treat one you RECEIVE that way: it came
  through wt, on the human's behalf, and asks for the same judgment any
  instruction does — not extra permission.
- Cross-branch merge-order knowledge becomes an EDGE, not just prose:
  `wt edge <from> before <to> [-m why]` (also `conflicts`, `enables`;
  `--blocks` for hard dependencies). Edges self-expire when either
  branch moves — assert what you know first-hand, re-assert after big
  changes if it still matters, never audit the list.
  **The general rule the edge is an instance of: cross-worktree
  knowledge travels as a written-down fact that expires, never as a
  conversation between worktrees.** A fact decays the moment it stops
  being true; a conversation argues, never expires, and needs somebody
  watching it. The cost is measured, not theoretical — getting one
  urgent worktree to the front of a full dev-slot queue took four
  messages between three agents who each cooperated correctly, and the
  ordering still came out wrong, because a slot promotion is instant
  and a message an agent must act on is not. That is also why relative
  urgency across the fleet is never yours to assert: you do not hold
  cross-worktree facts first-hand. State what you know about your own
  branch, and let the manager carry what spans branches.
- **Inside a session, call tools by NAME, never by absolute path.** wt
  puts a shim directory first on your PATH to strip an inspector
  variable that the session itself needs but that breaks any
  Bun-compiled CLI inheriting it. Some widely-used CLIs are compiled
  that way. Call one by its absolute path and you skip the shim: it
  dies on startup, exits non-zero, and prints **nothing at all** — not
  even for `--help` — which reads as a broken install or a bad PATH
  rather than an environment collision, so the search starts in the
  wrong place. This is worth naming because the usual advice pushes you
  into it: shell aliases genuinely do not exist inside `.sh` files, so
  scripts are told to call the full path, and that is right for an
  alias and wrong for a shimmed binary. If a tool exits silently with
  no output, check whether you invoked it by path before you suspect
  the install.
- **Report papercuts sideways.** Anything that cost you time and will cost
  the next agent the same — misleading command output, a wrong or stale
  doc, an undocumented trap — goes to the same channel:
  `wt manager send "papercut: <what you ran, what misled you, what you
  expected>"`. Fire and forget: nothing comes back, don't wait for a reply,
  keep working. A papercut is never a reason to sit in `needs-human`.
