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
- **Never end a session without a clear status.** Finished means
  `wt status ready --risk low|medium|high [-m ...]`, risk judged broadly (end
  users, coworker workflows, costs, migrations, reversibility). The note
  carries ONLY notable merge impacts the human should know — no noise;
  nothing notable is `--risk low` with no note. The human merges PRs; never
  merge one yourself.
- Fleet-level questions (merge order, cross-branch conflicts, who owns a
  shared change) go to the manager session: `wt manager send "..."`.
- **Report papercuts sideways.** Anything that cost you time and will cost
  the next agent the same — misleading command output, a wrong or stale
  doc, an undocumented trap — goes to the same channel:
  `wt manager send "papercut: <what you ran, what misled you, what you
  expected>"`. Fire and forget: nothing comes back, don't wait for a reply,
  keep working. A papercut is never a reason to sit in `needs-human`.
