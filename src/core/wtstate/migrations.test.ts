import { describe, expect, test } from "bun:test";

import {
  migrateRawWtState,
  rawWtStateVersion,
  runMigrations,
  WT_STATE_VERSION,
  type WtStateMigration,
} from "./migrations.ts";

describe("rawWtStateVersion", () => {
  test("reads a valid non-negative integer version", () => {
    expect(rawWtStateVersion({ version: 3 })).toBe(3);
    expect(rawWtStateVersion({ version: 0 })).toBe(0);
  });

  test("treats missing/invalid version values as 0", () => {
    expect(rawWtStateVersion({})).toBe(0);
    expect(rawWtStateVersion({ version: "1" })).toBe(0);
    expect(rawWtStateVersion({ version: 1.5 })).toBe(0);
    expect(rawWtStateVersion({ version: -1 })).toBe(0);
    expect(rawWtStateVersion({ version: null })).toBe(0);
  });
});

describe("migrateRawWtState (constant-bound wrapper)", () => {
  test("stamps a v0 (unversioned) file up to the current version", () => {
    const raw = { slugs: {} };
    const { value, from, to } = migrateRawWtState(raw);
    expect(from).toBe(0);
    expect(to).toBe(WT_STATE_VERSION);
    expect(value.version).toBe(WT_STATE_VERSION);
    // Non-version fields survive untouched (today's only migration is
    // pure stamping — no shape change yet).
    expect(value.slugs).toEqual({});
  });

  test("invalid version values are treated as 0 and migrated", () => {
    const raw = { version: "not-a-number", slugs: { a: 1 } };
    const { value, from } = migrateRawWtState(raw);
    expect(from).toBe(0);
    expect(value.version).toBe(WT_STATE_VERSION);
    expect(value.slugs).toEqual({ a: 1 });
  });

  test("a file already at the current version passes through unchanged", () => {
    const raw = { version: WT_STATE_VERSION, slugs: { a: 1 } };
    const { value, from, to } = migrateRawWtState(raw);
    expect(from).toBe(WT_STATE_VERSION);
    expect(to).toBe(WT_STATE_VERSION);
    expect(value).toEqual(raw);
  });
});

describe("runMigrations (parameterized — what the ordering/stepping logic is tested against)", () => {
  test("applies every migration with to > from, in ascending `to` order regardless of array order", () => {
    const applied: number[] = [];
    const migrations: WtStateMigration[] = [
      {
        to: 3,
        up: (raw) => {
          applied.push(3);
          return { ...raw, three: true };
        },
      },
      {
        to: 1,
        up: (raw) => {
          applied.push(1);
          return { ...raw, one: true };
        },
      },
      {
        to: 2,
        up: (raw) => {
          applied.push(2);
          return { ...raw, two: true };
        },
      },
    ];
    const { value, from, to } = runMigrations({}, migrations, 3);
    expect(from).toBe(0);
    expect(to).toBe(3);
    expect(applied).toEqual([1, 2, 3]);
    expect(value).toEqual({ one: true, two: true, three: true, version: 3 });
  });

  test("only runs steps past the file's current version", () => {
    const applied: number[] = [];
    const migrations: WtStateMigration[] = [
      { to: 1, up: (raw) => { applied.push(1); return { ...raw, one: true }; } },
      { to: 2, up: (raw) => { applied.push(2); return { ...raw, two: true }; } },
    ];
    const { value, from, to } = runMigrations({ version: 1 }, migrations, 2);
    expect(from).toBe(1);
    expect(to).toBe(2);
    expect(applied).toEqual([2]);
    expect(value).toEqual({ version: 2, two: true });
  });

  test("newer-than-target input (rollback scenario) passes through UNCHANGED, never down-stamped", () => {
    const migrations: WtStateMigration[] = [
      { to: 1, up: (raw) => ({ ...raw, mutated: true }) },
    ];
    const raw = { version: 5, someNewerField: "kept" };
    const { value, from, to } = runMigrations(raw, migrations, 1);
    expect(from).toBe(5);
    expect(to).toBe(5);
    expect(value).toBe(raw); // same reference — genuinely untouched
    expect(value).toEqual({ version: 5, someNewerField: "kept" });
  });

  test("invalid version values are treated as 0", () => {
    const migrations: WtStateMigration[] = [
      { to: 1, up: (raw) => ({ ...raw, migrated: true }) },
    ];
    const { value, from } = runMigrations({ version: {} }, migrations, 1);
    expect(from).toBe(0);
    expect(value).toEqual({ version: 1, migrated: true });
  });

  test("empty migrations list still stamps the target version", () => {
    const { value, from, to } = runMigrations({ foo: "bar" }, [], 1);
    expect(from).toBe(0);
    expect(to).toBe(1);
    expect(value).toEqual({ foo: "bar", version: 1 });
  });
});
