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
  challenge, an OAuth consent screen), a judgment call, or a check only a
  human can do. The note must say what you need AND what you already tried
  ("blocked on X; tried Y, Z") — and keep working on whatever isn't blocked
  while you wait. **The same blocker twice is a setup defect, not a human
  dependency** — a credential that re-prompts every run should be reported
  (below), not escalated again.
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
  says who holds the slots. Nothing is wrong and nobody needs asking. A dev server you start by hand is
  invisible to wt and to the human (no row, no status, no logs) and
  unsupervised. Short-lived servers for your own checks (`pnpm preview`,
  a watch runner) are different: run those bare, no wt involvement —
  they're tools of your task, and wt reaps anything still listening
  when the worktree is destroyed, so they can't leak. `[dev_server] is
  not configured` means the project has none — then start the dev
  server however the project documents.
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
- **Report papercuts sideways.** Anything that cost you time and will cost
  the next agent the same — misleading command output, a wrong or stale
  doc, an undocumented trap — goes to the same channel:
  `wt manager send "papercut: <what you ran, what misled you, what you
  expected>"`. Fire and forget: nothing comes back, don't wait for a reply,
  keep working. A papercut is never a reason to sit in `needs-human`.
