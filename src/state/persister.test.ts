import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Database } from "bun:sqlite";
import { Effect } from "effect";

import { clearPersistedCache, createSqliteAsyncStorage } from "./persister.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("SQLite query persistence", () => {
  test("storage operations are ordered and inert after close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-persister-test-"));
    dirs.push(dir);
    const storage = createSqliteAsyncStorage(join(dir, "cache.sqlite"));
    await storage.setItem("key", "value");
    expect(await storage.getItem("key")).toBe("value");
    expect(await storage.entries()).toEqual([["key", "value"]]);

    await storage.removeItem("key");
    expect(await storage.getItem("key")).toBeNull();
    const queuedWrite = storage.setItem("before-close", "flushed");
    await storage.close();
    await queuedWrite;
    const reopened = createSqliteAsyncStorage(join(dir, "cache.sqlite"));
    expect(await reopened.getItem("before-close")).toBe("flushed");
    await reopened.close();
    await storage.setItem("late", "write");
    expect(await storage.getItem("key")).toBeNull();
    expect(await storage.entries()).toEqual([]);
  });

  test("clear uses worker storage and empties the cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-persister-test-"));
    dirs.push(dir);
    const path = join(dir, "cache.sqlite");
    const storage = createSqliteAsyncStorage(path);
    await storage.setItem("key", "value");
    await storage.close();

    await Effect.runPromise(clearPersistedCache(path));
    const reopened = createSqliteAsyncStorage(path);
    expect(await reopened.entries()).toEqual([]);
    await reopened.close();
  });

  test("a held SQLite writer lock does not block the main event loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-persister-test-"));
    dirs.push(dir);
    const path = join(dir, "cache.sqlite");
    const storage = createSqliteAsyncStorage(path);
    await storage.setItem("seed", "ready");

    const blocker = new Database(path, { readwrite: true, create: false });
    blocker.exec("BEGIN IMMEDIATE;");
    let released = false;
    const startedAt = performance.now();
    const write = storage.setItem("locked", "value");
    const eventLoopPulse = delay(0).then(() => performance.now() - startedAt);
    const releaseLock = delay(200).then(() => {
        blocker.exec("ROLLBACK;");
        blocker.close();
        released = true;
    });

    const pulseMs = await eventLoopPulse;
    await releaseLock;
    await write;
    // Old main-thread SQLite writes sat behind the 1500ms busy timeout.
    expect(pulseMs).toBeLessThan(800);
    expect(released).toBe(true);
    expect(await storage.getItem("locked")).toBe("value");
    await storage.close();
  });

  test("a busy cache drops excess work and shutdown abandons its remaining backlog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-persister-test-"));
    dirs.push(dir);
    const path = join(dir, "cache.sqlite");
    const storage = createSqliteAsyncStorage(path);
    await storage.setItem("seed", "ready");
    const blocker = new Database(path, { readwrite: true, create: false });
    blocker.exec("BEGIN IMMEDIATE;");

    const writes = Array.from({ length: 300 }, (_, index) =>
      storage.setItem(`busy-${index}`, "value"),
    );
    const overflowDropped = await Promise.race([
      Promise.resolve(writes.at(-1)).then(() => true),
      delay(200).then(() => false),
    ]);
    const startedAt = performance.now();
    await storage.close();
    const closeMs = performance.now() - startedAt;
    blocker.exec("ROLLBACK;");
    blocker.close();
    await Promise.all(writes);

    expect(overflowDropped).toBe(true);
    expect(closeMs).toBeLessThan(3_000);
    await storage.setItem("late", "must not persist");
    const reopened = createSqliteAsyncStorage(path);
    expect(await reopened.getItem("seed")).toBe("ready");
    expect(await reopened.getItem("late")).toBeNull();
    await reopened.close();
  });
});
