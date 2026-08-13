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
  one here. `wt dev logs` is the output, and another slug's server is
  never yours to stop or restart. A dev server you start by hand is
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
