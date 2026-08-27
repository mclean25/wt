/**
 * Schema-version + forward-only migrations for `state.json` — the one
 * durable, non-rebuildable store (fork-base records, sections, work
 * statuses, removed-worktree history). wt self-updates hot from git
 * `main`; when the shape of `WtState`/`WtSlugState` changes, a
 * migration transforms the file in place instead of the new code
 * silently dropping/misreading old data.
 *
 * Contract:
 *  - Migrations are FORWARD-ONLY. There is no down-migration path — a
 *    code rollback recovers via the pre-migration backup `io.ts` writes
 *    (`state.json.bak-v<from>`), not by running anything here backward.
 *  - Each entry operates on the RAW parsed JSON (`Record<string,
 *    unknown>`), not the typed `WtState` — the whole point is to move
 *    data that no longer matches the current type definitions.
 *  - Entries run in ascending `to` order, each taking the previous
 *    entry's output as input, regardless of the array's declaration
 *    order (`runMigrations` sorts).
 *  - A shape change to `WtState` or `WtSlugState` MUST bump
 *    `WT_STATE_VERSION` and add a migration here — even a purely
 *    additive change, so a downgrade-then-upgrade cycle has a version
 *    boundary to detect.
 */

/** Current schema version. Bump alongside a new entry in `WT_STATE_MIGRATIONS`. */
export const WT_STATE_VERSION = 14;

export type WtStateMigration = {
  /** Target version this step produces. */
  to: number;
  /** Pure transform: previous raw shape in, next raw shape out. */
  up: (raw: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * Version 0 (no `version` field — every state.json written before this
 * system existed) to 1 was pure stamping, no shape change, so it has no
 * entry.
 */
export const WT_STATE_MIGRATIONS: WtStateMigration[] = [
  {
    // v2: additive — the attention-feed "seen" watermark. parseWtState
    // would default a missing field anyway; the entry exists so the
    // additive change has a version boundary (downgrade-then-upgrade
    // detection), per the contract above.
    to: 2,
    up: (raw) =>
      "attentionSeenTs" in raw ? raw : { ...raw, attentionSeenTs: 0 },
  },
  {
    // v3: additive — merge edges (`wt edge`, core/merge-edges.ts).
    // parseWtState defaults a missing array; the entry exists for the
    // version boundary, same as v2.
    to: 3,
    up: (raw) => ("edges" in raw ? raw : { ...raw, edges: [] }),
  },
  {
    // v4: additive — `by` on a work-status record (who asserted it).
    // Nothing to backfill: an existing record's asserter is genuinely
    // unknown, and "unknown" is exactly what an absent `by` means. The
    // entry exists for the version boundary, same as v2 and v3.
    to: 4,
    up: (raw) => raw,
  },
  {
    // v5: additive — `blockedOn` on a work-status record (an external
    // gate that must clear before the branch may be merged). Nothing to
    // backfill: an existing `ready` that was gated said so only in
    // prose, and guessing which notes meant it would be exactly the
    // prose-parsing this field exists to replace. The entry exists for
    // the version boundary, same as v2-v4.
    to: 5,
    up: (raw) => raw,
  },
  {
    // v6: additive — `devStartedSha` on a slug record (the HEAD a dev
    // server came up on). Nothing to backfill: a server already running
    // came up on a commit nobody recorded, and guessing HEAD now would
    // assert the one thing the field exists to detect. Absent reads as
    // "unknown", which suppresses the staleness signal until the next
    // start — the right way to be wrong.
    to: 6,
    up: (raw) => raw,
  },
  {
    // v7: additive — `examined`, the sha-keyed fleet verdict. Nothing to
    // backfill and nothing that could be: a verdict is a claim someone
    // made, and inventing one would defeat the point of recording who
    // concluded what. Absent means "nobody has looked", which is the
    // honest state of every row on the day this shipped.
    to: 7,
    up: (raw) => raw,
  },
  {
    // v8: additive — `examined.baseSha`. Nothing to backfill, and
    // deliberately so: a v7 verdict cannot prove its base held still,
    // and inventing a base for it would assert the one thing the field
    // was added to check. Absent reads as void, so old verdicts simply
    // stop skipping rows until they are re-examined.
    to: 8,
    up: (raw) => raw,
  },
  {
    // v9: additive — `verifyAfterMerge` on a work-status record (a
    // check that can only run once the change is deployed). Nothing to
    // backfill: no existing record can say whether its branch owed one,
    // and inventing an obligation would hold merged worktrees on the
    // board for a verification nobody asked for. Absent means "nothing
    // owed", which is the honest state of every row that predates it.
    to: 9,
    up: (raw) => raw,
  },
  {
    // v10: additive — `work` on a removed-history entry (the work
    // status the row held when its checkout went away). Nothing to
    // backfill and nothing recoverable: the per-slug record is reaped
    // with the worktree, so for entries written before this the answer
    // is genuinely gone. Absent reads as "unknown", never as "nothing
    // was owed" — the whole point of the field is that those two were
    // indistinguishable.
    to: 10,
    up: (raw) => raw,
  },
  {
    // v11: additive — `branchTips`, the per-branch watermark behind the
    // `branch.advanced` trigger. Nothing to backfill and deliberately
    // so: an invented mark would either fire a rule across history it
    // never saw, or silently swallow the first real range. Absent means
    // "not seen yet", and the first pass records the tip without firing.
    to: 11,
    up: (raw) => raw,
  },
  {
    // v12: additive — `issueId`, the per-slug tracker-id OVERRIDE
    // (`wt issue <slug> --id`). Deliberately NOT backfilled from the
    // slugs, even though most of them parse: the override exists for
    // the ids that are NOT derivable, and every reader falls back to
    // parsing the slug anyway (`resolveIssueId`). Backfilling would
    // copy a free, self-expiring derivation into storage, where a
    // later branch rename leaves it stale and authoritative-looking —
    // the one shape this store is not allowed to grow.
    to: 12,
    up: (raw) => raw,
  },
  {
    // v13: additive — `automationsPaused` on a REMOVED entry, so the
    // per-worktree pause survives the reap that takes the per-slug
    // record. No backfill: the flag it would copy from is already gone
    // by definition for every existing entry, and absence means not
    // paused, which is the honest answer for history written before
    // the pause could outlive its row.
    to: 13,
    up: (raw) => raw,
  },
  {
    // v14: no shape change — a MEANING change inside an unchanged one,
    // which needs a boundary just as much. `issueId: ""` used to be
    // dropped at parse and now means "this worktree has no tracker
    // issue", distinct from the field being absent ("use the slug").
    // Nothing before v14 could write an empty override (both doors
    // rejected it), so no existing value changes interpretation; the
    // bump is here so a downgrade-then-upgrade has a version to see.
    to: 14,
    up: (raw) => raw,
  },
];

/**
 * Read the schema version off a raw parsed state object. Missing or
 * malformed values (not a non-negative integer) read as `0` — the
 * pre-versioning shape. Shared by `runMigrations` and the `io.ts` read
 * path so the "does this need migrating" check has one definition.
 */
export function rawWtStateVersion(raw: Record<string, unknown>): number {
  const v = (raw as { version?: unknown }).version;
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

/**
 * Apply `migrations` to `raw`, stamping `targetVersion` on the result.
 * Parameterized so tests can exercise the stepping/ordering logic
 * against a synthetic migration list without waiting for a real schema
 * change; `migrateRawWtState` below is the constant-bound wrapper every
 * non-test caller uses.
 *
 * `from > targetVersion` means the file was written by NEWER code than
 * this build (a rollback scenario) — returned UNCHANGED. Never
 * down-stamp or transform: this build doesn't know the newer shape, so
 * touching the file could destroy data a newer-code read would still
 * understand.
 */
export function runMigrations(
  raw: Record<string, unknown>,
  migrations: readonly WtStateMigration[],
  targetVersion: number,
): { value: Record<string, unknown>; from: number; to: number } {
  const from = rawWtStateVersion(raw);
  if (from > targetVersion) {
    return { value: raw, from, to: from };
  }
  const steps = migrations.filter((m) => m.to > from).sort((a, b) => a.to - b.to);
  let value = raw;
  for (const step of steps) {
    value = step.up(value);
  }
  value = { ...value, version: targetVersion };
  return { value, from, to: targetVersion };
}

/** `runMigrations` bound to the real migration list and current version. */
export function migrateRawWtState(
  raw: Record<string, unknown>,
): { value: Record<string, unknown>; from: number; to: number } {
  return runMigrations(raw, WT_STATE_MIGRATIONS, WT_STATE_VERSION);
}
