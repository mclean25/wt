# GitHub webhooks

Without this, PR / checks / merge-queue badges stay fresh via a local `.git/refs` watcher, a 3-minute PR-fetch poll, a 3-minute `git fetch origin` backstop, and manual `r`. That works, but everything that happens on the GitHub side (CI finishing, reviews landing, someone commenting on your PR) waits out the poll — up to three minutes, and the attention feed's comment lines wait with it.

Add a `[github.events]` section and run the small local daemon to have GitHub **push** updates instead: badges flip within a second or two of the event, far fewer `gh` calls, and the daemon keeps a warm snapshot so a freshly opened TUI already shows current state. Config keys: [configuration.md](configuration.md#githubevents--optional-webhook-daemon).

It's a plain repo webhook — no GitHub App, no OAuth.

**What it is not: a fix for GitHub 5xx errors.** The daemon re-runs the *same* batched `fetchGithub` the TUI uses, so it changes how OFTEN the query runs, never what one costs. A fleet large enough to cross GitHub's per-query execution ceiling failed identically with the daemon configured, just less frequently. Query cost is bounded by chunking instead (see [architecture.md](architecture.md#state--data-flow)), which the daemon inherits for free.

## Setup

```sh
wt events install     # writes a launchd agent + generates the HMAC secret
wt events start       # load the daemon
wt events restart     # reconcile and reload it on the current wt build
wt events status      # liveness, last delivery, snapshot age
```

`install` prints exactly what to paste into the repo's **Settings → Webhooks**: the payload URL, content type `application/json`, the generated secret, and the event checklist (`pull_request`, `pull_request_review`, `pull_request_review_thread`, `issue_comment`, `check_suite`, `check_run`, `status`, `merge_group`, `push`). `issue_comment` feeds the details-pane conversation, the attention feed's "someone commented on your PR" lines ([tui.md](tui.md)), and, for a checklist-mode [`[review_bot]`](configuration.md#review_bot--the-bot-review-track), the summary comment + checkbox ticks that drive its badge.

The daemon listens on `[github.events].host` (default loopback); map a public HTTPS URL to it however you route traffic into your network — a tunnel or reverse proxy on the same machine forwarding to localhost is the simple case. If a reverse proxy on a *different* host has to reach this machine, set `host` to a LAN IP or `0.0.0.0`; the HMAC secret is then the only auth boundary, so keep the listener on a trusted network.

## Security model

- Every delivery is verified against `X-Hub-Signature-256` (HMAC, constant-time compare). Unsigned or mis-signed requests are rejected.
- Webhook payloads are a **refresh signal, never a data source**: the daemon only ever re-runs the same read-only `gh` fetch the TUI already uses. A forged payload's worst case is an extra fetch.
- `wt events secret` rotates or shows the secret; `wt events uninstall` removes the launchd agent.

Omit the `[github.events]` section entirely and nothing changes — the daemon subcommands just refuse to run, and the TUI stays in watcher + backstop mode. If the daemon dies mid-session, `backstop_poll_ms` (default 10 minutes) bounds how stale the badges can get.

## The daemon's build, and why the TUI checks it

`github.json` holds **parsed** `PullRequest` objects, not the raw GraphQL
payload, so a snapshot carries the writing build's parsing rules with it. The
writer is a launchd agent with `KeepAlive`, which means it survives every hot
update and can be arbitrarily older than the TUI reading it. Nothing said so:
`wt events status` reported "running", the fetches succeeded, and the TUI
preferred the snapshot over its own fetch, so a daemon started weeks earlier
quietly overrode every parsing fix the TUI had.

That cost two visible wrong badges on one day, both on a TUI that already held
the fix: a red checks badge on a PR whose only failure was a superseded
`CANCELLED` job (the daemon predated the rollup dedupe), and a stale review-bot
badge on a PR whose delta review named the head sha (it predated `coversHead`).
Both read as wt bugs against a working GitHub.

Two halves, in `core/build-id.ts`:

- **The snapshot is stamped** with `writerSha`, the source clone's HEAD.
  `snapshotForBranches` refuses a snapshot from a different build and falls back
  to a live fetch, narrating once on `log.attention.*`. A **missing** stamp is
  refused too — only a build predating the field writes one, so absence is the
  diagnosis rather than a missing input. It fails *open* only when the reader
  cannot identify itself at all (wt is not a git checkout), where there is no
  version question to answer.
- **The daemon stands down** when it notices the source clone move under it,
  checked at the top of each fetch. `KeepAlive` means exiting *is* the upgrade.
  Nothing is lost: the delivery that woke it re-arrives as the restarted
  daemon's warm-up fetch.

`wt events status` prints a `build` line when the two disagree, so "running" and
"up to date" stop being the same answer.

An accepted pre-TUI update also runs `wt events restart` automatically when
the launchd agent is installed. The daemon therefore moves to the new build
before the fresh TUI starts. A restart failure is printed but does not block
the TUI; rerun the command manually after fixing the reported launchd error.

The identity is the committed sha, so an **uncommitted** edit moves the code
without moving it — a daemon started mid-edit still looks current. That gap is
deliberate: closing it means a `git status` per read, and a daemon is stale by
spanning commits, which is what a long-lived process does by construction.

## The launchd agent execs `bin/wt`, not the interpreter

`wt events install` used to bake `process.execPath` into the plist. On Homebrew
that is a **version-specific** path (`/opt/homebrew/Cellar/bun/1.3.14/bin/bun`),
and `brew upgrade bun` deletes it.

The failure this produces has no output anywhere. launchd never execs anything,
so `StandardOutPath` and `StandardErrorPath` both stay empty; `launchctl list`
shows a bare exit **78**; and a daemon that is *already running* survives the
upgrade untouched, so the agent reads healthy for as long as nobody restarts
it. It is dead the first time anybody does — which on this machine was seven
days later, and only because the daemon was being restarted to fix something
else.

So the program is `bin/wt`, which resolves `bun` off the PATH the plist bakes
(and brings the `env -u BUN_INSPECT` scrub with it). bun's own directory moves
to the END of that PATH: it is a fallback for a bun that is not on PATH, never
the primary.

A source fix cannot repair a plist an older version already wrote, so
`wt events start` and `wt events restart` **reconcile** — they rewrite the
plist whenever the stored one differs from what the current environment would
generate, and say so, naming the missing program when that is why. `wt events
status` reports an `agent cannot exec` line for the same condition. `restart`
also waits for a new live daemon PID before returning, so a launchd load that
never reaches daemon readiness is reported as a failure.

## Fetch cadence

A delivery does not map to a fetch. Two constraints compose in `scheduleFetch`:

- **`FETCH_DEBOUNCE_MS` (1.5s)** collapses deliveries that arrive together. One CI step storm is a dozen `check_run` events at the same instant, and they are worth exactly one refetch.
- **`MIN_FETCH_INTERVAL_MS` (30s)** floors the sustained rate, measured from the previous fetch's *start* so a slow query eats into the floor rather than adding to it.

The floor exists because the debounce alone does not bound anything under a *stream*. Measured on an 18-branch fleet with a merge queue running CI: 130 accepted deliveries in 180s produced 13 full refetches at ~30 GraphQL points each, a pace of 7,760 points/hour against a 5,000/hour limit. Nothing was failing, but the budget was on track to run out before its reset window, and a rate-limited fetch is the one failure `fetchGithub` deliberately never retries (see [architecture.md](architecture.md#state--data-flow)).

**The floor is not a responsiveness tradeoff, because of which fetch it delays.** It only ever defers the *Nth* fetch of a burst. The first delivery after a quiet spell still lands in 1.5s, and that is the case that governs how fast a badge flips after you push. It is also a third of the 90s `SNAPSHOT_FRESH_MS`, so a deferred fetch is still comfortably inside the window the TUI already treats as current.

Cadence is auditable from the daily app log: each `refetched after webhook` line carries `sinceLastMs`.

**Trap for anything that adds another fetch path here.** The trailing re-run after a burst that lands mid-fetch must go through `scheduleFetch`, never straight back into `runFetch`. Running it immediately is unbounded, and it also *masks* a starvation bug in the debounce: deliveries arriving closer together than the debounce window re-arm the timer indefinitely (simulated at this fleet's measured ~43/min, the naive rule defers past 151s and climbing). `nextFetchAt` is the single scheduling rule for exactly that reason — it refuses to push out an already-pending timer, and `daemon.test.ts` pins both halves.
