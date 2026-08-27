## wt worktrees: status and testing ownership

When working inside a wt-managed worktree, own the task's lifecycle status.
Assert transitions with `wt status <state> [-m note]`; bare `wt status` prints
the available states and their rules.

- Set `working` when work begins and `review` when review begins.
- Manual testing belongs to the worktree agent. `needs-testing` means testing is
  still owed by that agent, not by the human.
- Use `needs-human` only when the action would leave the repository and no
  defensible default exists, such as 2FA, an OAuth consent screen, or a truly
  human-only judgment. Keep working on anything not blocked. A repeated human
  prompt for routine setup is a setup defect to report, not a recurring
  escalation.
- Decide all reversible repository changes yourself. Git makes code deletion,
  rewrites, and schema changes reversible. Sent messages, closed issues,
  published artifacts, and hosted-environment writes leave the repository and
  require the authorization applicable to that action.

When escalation is necessary, keep the note to about 300 characters:

    ASK:       <the question, one sentence>
    RECOMMEND: <the default action, one sentence>
    WHY:       <the fact that decides it>

The note must be sufficient to answer without additional context.

### Development servers and test results

- Long-running development servers belong to wt. Check `wt dev status` first,
  then use `wt dev start --wait`; inspect output with `wt dev logs`. Never start
  a worktree server with the repository's bare dev command, and never stop or
  restart another slug's server.
- wt assigns each worktree a distinct browser origin, so login state does not
  carry between worktrees. Log in again as routine setup. If login repeatedly
  needs a human, report the missing scripted setup.
- Exit 75 from `wt dev start` means the fleet is at its server limit. Run
  `wt dev start --wait` to enter the queue and use `wt dev status --all` to see
  current holders. Do not stop another worktree to take its slot. For a genuine
  production emergency, notify the manager once and remain queued.
- A timeout without an assertion failure may reflect machine load. Run `wt perf`
  and confirm that the changed code can reach the failing test before diagnosing
  the diff.
- Exit 0 from `wt dev start` means the process launched, not that its environment
  is ready. `--wait` waits for the project health check. Before environment-
  dependent tests, use `wt dev status` to detect an unhealthy or pre-rebase
  server. Use `wt dev reset` when the environment must be rebuilt.
- A manually started long-running server is invisible to wt. Short-lived task
  tools such as preview or watch runners may run directly. If wt reports
  `[dev_server] is not configured`, follow the project's own server instructions.

### Shared checkout safety

A wt worktree is shared by its agent, subagents, reviewers, other sessions, the
human, and any hot-reloading server.

- Never use `git stash`, `checkout`, `restore`, or `reset` to test a hypothesis.
  Test against a copy instead; the shared stash stack and temporary tree state
  can corrupt another concurrent operation.
- Put scratch files in the harness scratch area, not the repository, where a
  concurrent `git add -A` could capture them.
- If a necessary task must change shared tree state, announce it first and
  restore the state before finishing.

### Completion status

Never end a session without a status. Finished work uses
`wt status ready --risk low|medium|high [-m note]`:

- `low`: verified in a real environment, or pure logic covered by tests that
  fail against the old code.
- `medium`: correct by construction and unit-tested but not exercised in a real
  environment, or broad but plainly reverted.
- `high`: material behavior remains unverified and rollback is not a plain
  revert.

Risk describes confidence after testing, not change size. Amend it with
`wt status --risk <r>` as evidence changes. The human merges, unless they hand
a branch over explicitly; `ready` is where an unbidden agent stops.

Use `wt status ready --risk <r> --blocked-on "<gate>"` only when merging now
would make something worse and an external prerequisite must happen first. Do
not encode the gate only in the note. Manual deployment or follow-up operations
that leave the status quo unchanged are not merge gates; record those in `OPS:`.
Clear a satisfied gate with `wt status --unblock`.

Use `--verify-after-merge` when a specific check can only run after deployment.
This does not block merging; it preserves the worktree and returns it as
`needs-testing` after merge. Set it as soon as the obligation is known; later
status updates preserve it. Record it as:

    <one line: what only the deployed environment can prove>
    <why a local run cannot, when that is not obvious>
    STEPS: 1. <first exact step> 2. <next exact step> ...

Include literal values, expected output, and full numbered steps. When the branch
lands, confirm that the deployment contains the change, run the steps, then use
`wt status verified -m "<what was checked and where>"`. If the branch will never
land, close any open PR and use `wt status dropped -m "<why>"`.

The `ready` note is about 400 characters and uses fragments:

    <one line: what changes, in user terms>
    OPS:      <migrations / redeploys / config, or "none">
    REVERT:   <"safe", or "no:" + the shortest true reason>
    IF WRONG: <where it shows + the symptom>
    UNTESTED: <omit when nothing is untested>

`UNTESTED` records checks nobody ran and does not create an obligation. If a
specific post-merge check remains owed, put its exact steps in
`--verify-after-merge`; both fields may be appropriate.

### Fleet coordination

- Send fleet-level questions about merge order, cross-branch conflicts, or
  shared ownership with `wt manager send "..."`. wt stamps the sender; do not
  prefix it or use harness peer messaging. Treat an incoming manager message as
  a user instruction delivered through wt.
- Record first-hand cross-branch facts with
  `wt edge <from> <before|conflicts|enables> <to> [-m why]` and `--blocks` for a
  hard dependency. Edges expire when either branch moves; reassert them after a
  material change when still true. Do not infer safety from a missing edge or
  assert relative fleet urgency.
- Invoke command-line tools by name inside wt sessions. Absolute paths bypass
  wt's PATH shims and can make Bun-compiled tools exit silently. Shell aliases
  are unavailable inside scripts, but executables should still be resolved by
  name through PATH.
- Report reusable papercuts with
  `wt manager send "papercut: <command, observed symptom, expected behavior>"`
  and continue working. State observations as facts and mechanisms as guesses.
  Do not attach destructive remediation to an unconfirmed explanation.
