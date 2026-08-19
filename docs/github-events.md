# GitHub webhooks

Without this, PR / checks / merge-queue badges stay fresh via a local `.git/refs` watcher, a 3-minute PR-fetch poll, a 3-minute `git fetch origin` backstop, and manual `r`. That works, but everything that happens on the GitHub side (CI finishing, reviews landing, someone commenting on your PR) waits out the poll — up to three minutes, and the attention feed's comment lines wait with it.

Add a `[github.events]` section and run the small local daemon to have GitHub **push** updates instead: badges flip within a second or two of the event, far fewer `gh` calls, and the daemon keeps a warm snapshot so a freshly opened TUI already shows current state. Config keys: [configuration.md](configuration.md#githubevents--optional-webhook-daemon).

It's a plain repo webhook — no GitHub App, no OAuth.

**What it is not: a fix for GitHub 5xx errors.** The daemon re-runs the *same* batched `fetchGithub` the TUI uses, so it changes how OFTEN the query runs, never what one costs. A fleet large enough to cross GitHub's per-query execution ceiling failed identically with the daemon configured, just less frequently. Query cost is bounded by chunking instead (see [architecture.md](architecture.md#state--data-flow)), which the daemon inherits for free.

## Setup

```sh
wt events install     # writes a launchd agent + generates the HMAC secret
wt events start       # load the daemon
wt events status      # liveness, last delivery, snapshot age
```

`install` prints exactly what to paste into the repo's **Settings → Webhooks**: the payload URL, content type `application/json`, the generated secret, and the event checklist (`pull_request`, `pull_request_review`, `pull_request_review_thread`, `issue_comment`, `check_suite`, `check_run`, `status`, `merge_group`, `push`). `issue_comment` feeds the details-pane conversation, the attention feed's "someone commented on your PR" lines ([tui.md](tui.md)), and, for a checklist-mode [`[review_bot]`](configuration.md#review_bot--the-bot-review-track), the summary comment + checkbox ticks that drive its badge.

The daemon listens on `[github.events].host` (default loopback); map a public HTTPS URL to it however you route traffic into your network — a tunnel or reverse proxy on the same machine forwarding to localhost is the simple case. If a reverse proxy on a *different* host has to reach this machine, set `host` to a LAN IP or `0.0.0.0`; the HMAC secret is then the only auth boundary, so keep the listener on a trusted network.

## Security model

- Every delivery is verified against `X-Hub-Signature-256` (HMAC, constant-time compare). Unsigned or mis-signed requests are rejected.
- Webhook payloads are a **refresh signal, never a data source**: the daemon only ever re-runs the same read-only `gh` fetch the TUI already uses. A forged payload's worst case is an extra fetch.
- `wt events secret` rotates or shows the secret; `wt events uninstall` removes the launchd agent.

Omit the `[github.events]` section entirely and nothing changes — the daemon subcommands just refuse to run, and the TUI stays in watcher + backstop mode. If the daemon dies mid-session, `backstop_poll_ms` (default 10 minutes) bounds how stale the badges can get.

## Fetch cadence

A delivery does not map to a fetch. Two constraints compose in `scheduleFetch`:

- **`FETCH_DEBOUNCE_MS` (1.5s)** collapses deliveries that arrive together. One CI step storm is a dozen `check_run` events at the same instant, and they are worth exactly one refetch.
- **`MIN_FETCH_INTERVAL_MS` (30s)** floors the sustained rate, measured from the previous fetch's *start* so a slow query eats into the floor rather than adding to it.

The floor exists because the debounce alone does not bound anything under a *stream*. Measured on an 18-branch fleet with a merge queue running CI: 130 accepted deliveries in 180s produced 13 full refetches at ~30 GraphQL points each, a pace of 7,760 points/hour against a 5,000/hour limit. Nothing was failing, but the budget was on track to run out before its reset window, and a rate-limited fetch is the one failure `fetchGithub` deliberately never retries (see [architecture.md](architecture.md#state--data-flow)).

**The floor is not a responsiveness tradeoff, because of which fetch it delays.** It only ever defers the *Nth* fetch of a burst. The first delivery after a quiet spell still lands in 1.5s, and that is the case that governs how fast a badge flips after you push. It is also a third of the 90s `SNAPSHOT_FRESH_MS`, so a deferred fetch is still comfortably inside the window the TUI already treats as current.

Cadence is auditable from the daily app log: each `refetched after webhook` line carries `sinceLastMs`.

**Trap for anything that adds another fetch path here.** The trailing re-run after a burst that lands mid-fetch must go through `scheduleFetch`, never straight back into `runFetch`. Running it immediately is unbounded, and it also *masks* a starvation bug in the debounce: deliveries arriving closer together than the debounce window re-arm the timer indefinitely (simulated at this fleet's measured ~43/min, the naive rule defers past 151s and climbing). `nextFetchAt` is the single scheduling rule for exactly that reason — it refuses to push out an already-pending timer, and `daemon.test.ts` pins both halves.
