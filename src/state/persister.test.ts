import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearPersistedCache, createSqliteAsyncStorage } from "./persister.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("SQLite query persistence", () => {
  test("storage operations become inert after close", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-persister-test-"));
    dirs.push(dir);
    const storage = createSqliteAsyncStorage(join(dir, "cache.sqlite"));
    storage.setItem("key", "value");
    expect(storage.getItem("key")).toBe("value");
    expect(storage.entries()).toEqual([["key", "value"]]);

    storage.close();
    expect(() => storage.setItem("late", "write")).not.toThrow();
    expect(storage.getItem("key")).toBeNull();
    expect(storage.entries()).toEqual([]);
  });

  test("clear closes its short-lived handle and empties the cache", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-persister-test-"));
    dirs.push(dir);
    const path = join(dir, "cache.sqlite");
    const storage = createSqliteAsyncStorage(path);
    storage.setItem("key", "value");
    storage.close();

    clearPersistedCache(path);
    const reopened = createSqliteAsyncStorage(path);
    expect(reopened.entries()).toEqual([]);
    reopened.close();
  });
});
