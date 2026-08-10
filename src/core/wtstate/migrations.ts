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
export const WT_STATE_VERSION = 1;

export type WtStateMigration = {
  /** Target version this step produces. */
  to: number;
  /** Pure transform: previous raw shape in, next raw shape out. */
  up: (raw: Record<string, unknown>) => Record<string, unknown>;
};

/**
 * Empty today: version 0 (no `version` field — every state.json written
 * before this system existed) to version 1 is pure stamping, no shape
 * change. The first real entry lands here the day `WtState` next changes.
 */
export const WT_STATE_MIGRATIONS: WtStateMigration[] = [];

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
