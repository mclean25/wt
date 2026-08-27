# Updates, rollback & compatibility

wt has no release process: `main` is the release channel, and installs
are git clones that fast-forward (see [cli.md](cli.md#wt-update-log---check---head)
for command surface). What makes that safe is not a version scheme but
four layers around the pull — prevent, detect, recover, evolve. This
page is the semantics reference for those layers; the enforcement rules
for people (and agents) changing wt live in `AGENTS.md`.

## The moving parts

- **Version** = the source clone's git short hash (`wt version`, the
  help overlay title). `-dirty` marks local modifications.
- **Memory** = `~/.cache/wt/update.json`, machine-global (one source
  clone per machine, shared by every instance including sealed ones):
  the daily-check stamp, the per-version decline, the update/rollback
  **journal**, the **boot sentinel**, and the **last good boot** sha.
- Everything under `src/core/update/` (and the `wt rollback` command
  path) is deliberately **config-free** — no imports of `core/config.ts`,
  `proc`, `locks`, or `logger` at module load (its logging goes to a
  fixed `~/.cache/wt/logs/update.log` instead). The crash-rollback
  offer must work when the config loader is exactly what the broken
  update can't run — and so must the commands: main.ts dispatches
  `update` / `rollback` / `version` AROUND `cli/index.ts`, whose static
  command imports would otherwise pull the fail-fast loader in first.
- Update/rollback git mutations on the shared clone are serialized by a
  config-free mkdir lock (`~/.cache/wt/update-git.lock`, stale-holder
  detection by pid); a second concurrent update/rollback gets "another
  update is in progress" instead of interleaved resets.

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
because matching is by check-run name. When the pick rests on an
"unknown" verdict the CLI says so ("CI status couldn't be verified —
the gate fails open") rather than letting a network problem impersonate
a green check. `wt update --head` bypasses the gate explicitly.

**Boot probe.** After the fast-forward (and a `bun install` when the
dependency manifest changed), the updater boot-probes the checkout in a
child process: `wt version` (the CLI chain) and an import of the full
TUI module tree — which loads `core/config.ts` and therefore also
catches "new code rejects the user's existing config", the likeliest
hot-update break. A probe failure reverts code *and* deps, declines
that version (so the daily check skips it until origin moves), and
leaves the user on what they had. A broken push therefore usually
costs its author a red X, not a user a broken install.

**What the gate does not do is tell anyone it is holding.** A red `main`
stops shipping silently: users stay on their last green version, which is
the correct behaviour and produces no message anywhere. `main` was red from
2026-08-24 to 08-26 and the only visible symptom was the Discord #updates
channel going quiet, because that digest is gated on the same green run
(see [discord.md](discord.md)). When updates seem to have stopped, check
whether `main` is green before looking at `core/update/`.

**Lazy command dispatch.** For the pushes that do get through, the CLI
limits how far one broken module reaches: `cli/index.ts` imports each
subcommand's module graph on demand, so `wt status` doesn't load the
message transport and survives a break in it. It matters most for the
commands agents depend on to report trouble — a fleet that can't run
`wt status` or `wt manager report` can't tell anyone the update went
bad. `scripts/broken-module-check.sh` asserts the containment; see
[architecture.md](architecture.md#module-layout-conventions).

## Detect: the boot sentinel

Starting the TUI writes `booting: {sha, at}` to the memory; the sha is
promoted to `lastGoodSha` (and the sentinel cleared) after 15 s alive
or a clean quit, whichever comes first. The crash handler cancels the
pending promotion first, so a crashed sha can't be stamped good while
the rollback prompt waits for an answer. An update additionally writes
an `applying: {fromSha, toSha}` marker before its merge moves HEAD —
if the process dies mid-update (the deps/probe window runs seconds to
minutes), the offers treat the marker like a journal entry, so even an
interrupted update leaves a rollback target. Two detectors hang off
the sentinel:

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
it doesn't know. The pre-migration backup helps with that repair, with
an honest caveat: it snapshots the file at migration time, so edits
made after the migration aren't in it — restoring is a revert to that
snapshot, not a surgical recovery. Backups are one small file per
version bump (`state.json.bak-v<N>`, overwritten on repeat), so they
don't meaningfully accumulate.

The same field-dropping applies WITHOUT a rollback during the mixed-
version window after an additive field ships: a still-running TUI on
the previous build strips the new field on its next state write (its
`parseWtState` doesn't know the key), and new-code CLI processes
re-migrate the file right back — so values written to a brand-new
field can silently vanish until every long-lived wt process has
restarted onto the new build (observed live with `edges` at v3).
Bounded by restart, but worth knowing when a freshly-shipped record
"didn't stick".

**This is now detected rather than remembered.** Relying on a human to
recall the caveat failed exactly as you'd expect: seven merge edges
were stripped this way and were only noticed because someone re-listed
them on a hunch — from the outside, the board simply didn't contain
what an agent said it had recorded. Every write from a current build
records `state.writer.json` beside the state file, holding the mtime it
just produced; on read, a mismatch means something wrote `state.json`
that doesn't maintain that stamp, which is reported on the attention
feed (naming the older build's state version when the file was
down-stamped, since that identifies the culprit). The signal has to
live outside `state.json` precisely because an older build both strips
unknown fields — so an in-file writer stamp is the first thing to go —
and rewrites `version` to its own on write, leaving neither the stamp
nor the version to compare. It self-expires: the next write from a
current build re-syncs the pair, which is exactly when the danger
window closes. It is reported once per occurrence, not once per
process, and the recovery it names is the one nobody thinks to take —
re-assert what you recorded recently, and restart long-lived wt
processes to close the window.

The blast radius is exactly the fields that are new to the running
build, and nothing else. `parseWtState` is a whitelist parser: it
rebuilds each record from the fields it knows, so a field an old build
knows (`section`, `order`, `work`, `baseBranch`, …) round-trips through
that build untouched. A downgrade write can therefore never drop or
default a pre-existing value — if long-standing state looks like it
moved on its own, the cause is elsewhere, and the daily log is where to
settle it (section moves and fold toggles are recorded there for exactly
this reason).

## Escape hatches

`[update] startup_check = false` disables the daily startup offer;
`WT_UPDATE=off` disables the entire update system (check, sentinel,
offers) for one run — the probe harness arms it. Everything the
automation does is also just git: `git -C ~/.wt log|reset|pull` remain
the ultimate manual override.
