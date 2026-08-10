# Updates, rollback & compatibility

wt has no release process: `main` is the release channel, and installs
are git clones that fast-forward (see [cli.md](cli.md#wt-update-log---check---head)
for command surface). What makes that safe is not a version scheme but
four layers around the pull — prevent, detect, recover, evolve. This
page is the semantics reference for those layers; the enforcement rules
for people (and agents) changing wt live in `CLAUDE.md`.

## The moving parts

- **Version** = the source clone's git short hash (`wt version`, the
  help overlay title). `-dirty` marks local modifications.
- **Memory** = `~/.cache/wt/update.json`, machine-global (one source
  clone per machine, shared by every instance including sealed ones):
  the daily-check stamp, the per-version decline, the update/rollback
  **journal**, the **boot sentinel**, and the **last good boot** sha.
- Everything under `src/core/update/` (and the `wt rollback` command
  path) is deliberately **config-free** — no imports of `core/config.ts`,
  `proc`, `locks`, or `logger` at module load. The crash-rollback offer
  must work when the config loader is exactly what the broken update
  can't run.

## Prevent: the CI gate and the boot probe

**Green-main gate.** The updater doesn't target origin's raw tip: it
walks the incoming commits newest-first and targets the newest one
whose CI check run (names `ci` / `typecheck`, see
`.github/workflows/ci.yml` and `GATE_CHECK_NAMES` in
`core/update/green.ts`) concluded green. Red and still-running commits
are held back; commits with *no* matching check runs (pre-CI history),
API failures, rate limits, and non-GitHub origins all **fail open** —
the gate exists to skip known-bad pushes, never to strand anyone.
Unrelated workflows (e.g. the Discord digest) can't veto an update
because matching is by check-run name. `wt update --head` bypasses the
gate explicitly.

**Boot probe.** After the fast-forward (and a `bun install` when the
dependency manifest changed), the updater boot-probes the checkout in a
child process: `wt version` (the CLI chain) and an import of the full
TUI module tree — which loads `core/config.ts` and therefore also
catches "new code rejects the user's existing config", the likeliest
hot-update break. A probe failure reverts code *and* deps, declines
that version (so the daily check skips it until origin moves), and
leaves the user on what they had. A broken push therefore usually
costs its author a red X, not a user a broken install.

## Detect: the boot sentinel

Starting the TUI writes `booting: {sha, at}` to the memory; the sha is
promoted to `lastGoodSha` (and the sentinel cleared) after 15 s alive
or a clean quit, whichever comes first. Two detectors hang off this:

- **Crash offer** — the top-level catch in `main.ts`: if the process
  dies while HEAD is a journaled update that never booted good, offer
  a rollback (default **yes** — the crash is proven).
- **Stale-sentinel offer** — pre-TUI at the next launch: a leftover
  sentinel for the current HEAD means the previous start never
  finished (native crash, kill). Weaker evidence, so the offer
  defaults to **no**, and a subsequent healthy boot clears the
  suspicion.

Both offers (and sentinel writes) are disabled by `WT_UPDATE=off`, so
probe-harness instances can't leave false crash evidence.

## Recover: rollback

`wt rollback [<ref>]` resets the clone to the last version that booted
healthy (or an explicit ref), syncs deps across the jump, journals the
move, and — the piece that makes it stick — records the abandoned sha
as **declined**, so the startup check won't re-offer the known-bad
version. The moment origin moves past it (presumably the fix), offers
resume. `wt update` explicitly can always re-apply anything. Rollback
refuses dirty/ahead clones for the same reason update does: local
divergence means a human is driving.

`wt update log` prints the journal (updates and rollbacks, newest
first) plus current / last-good / skipped shas.

## Evolve: data compatibility across hot updates

Three stores, three policies:

- **`state.json`** (fork bases, sections, work statuses, removed
  history — durable, not rebuildable): versioned with forward-only
  migrations (`core/wtstate/migrations.ts`, `WT_STATE_VERSION`). A
  migration writes a backup first (`state.json.bak-v<from>` beside the
  file), transforms, and stamps. State written by *newer* code (after
  a rollback) is read leniently and never down-stamped or rewritten.
- **`cache.sqlite`** (persisted queries — fully rebuildable): no
  migrations, ever. `CACHE_BUSTER` in `src/state/client.ts` busts the
  whole persisted cache on any shape change; busting is the *correct*
  policy for this store, formalized.
- **User config** (hand-written TOML): never rewritten by wt. Renames
  get loader aliases plus a deprecation warning (the
  `TRIGGER_ALIASES` pattern in `core/config.ts`); new fields get
  defaults or a fail-fast error with a copy-pasteable snippet. A
  config that loaded yesterday must load today.

Known limitation: rolling back *across* a state migration runs old
code against newer-shaped state. Parsing is lenient so it degrades
rather than breaks, but a subsequent write by old code can drop fields
it doesn't know; the pre-migration backup exists for exactly that
repair (`cp` it back by hand).

## Escape hatches

`[update] startup_check = false` disables the daily startup offer;
`WT_UPDATE=off` disables the entire update system (check, sentinel,
offers) for one run — the probe harness arms it. Everything the
automation does is also just git: `git -C ~/.wt log|reset|pull` remain
the ultimate manual override.
