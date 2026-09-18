import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __setLedgerPathForTests,
  breakerState,
  bumpBreaker,
  cancelAutomationFires,
  dropFires,
  hasHandledFire,
  lastDispatchAt,
  markFiresDelivered,
  markFiresDispatched,
  reconcileDispatchedFires,
  resetBreaker,
  tripBreaker,
} from "./automations.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wt-auto-ledger-"));
  __setLedgerPathForTests(join(dir, "automations.json"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fire ledger", () => {
  test("cancelled pending fires survive reload without changing running fires or cooldowns", async () => {
    markFiresDispatched(["running"], "fix", "a");
    const before = lastDispatchAt("fix", "a");
    await Effect.runPromise(cancelAutomationFires(["pending", "running"]));
    const stored = JSON.parse(readFileSync(join(dir, "automations.json"), "utf8"));
    expect(stored.fired.pending.state).toBe("cancelled");
    expect(stored.fired.running.state).toBe("dispatched");
    __setLedgerPathForTests(join(dir, "automations.json"));
    expect(hasHandledFire("pending")).toBe(true);
    expect(hasHandledFire("new-instance")).toBe(false);
    expect(lastDispatchAt("fix", "a")).toBe(before);
    expect(breakerState("fix", "a").count).toBe(0);
    reconcileDispatchedFires(() => false);
    expect(hasHandledFire("pending")).toBe(true);
  });

  test("failed cancellation writes roll back memory and report failure", async () => {
    const obstacle = join(dir, "not-a-directory");
    writeFileSync(obstacle, "fixture");
    __setLedgerPathForTests(join(obstacle, "automations.json"));
    const result = await Effect.runPromise(Effect.result(cancelAutomationFires(["pending"])));
    expect(result._tag).toBe("Failure");
    expect(hasHandledFire("pending")).toBe(false);
  });

  test("dispatched keys count as handled and persist across a reload", () => {
    expect(hasHandledFire("ci:a:sha1")).toBe(false);
    markFiresDispatched(["ci:a:sha1", "ci:a:sha2"], "fix-ci", "a");
    expect(hasHandledFire("ci:a:sha1")).toBe(true);
    expect(hasHandledFire("ci:a:sha2")).toBe(true);
    // Reload from disk (fresh singleton, same file).
    __setLedgerPathForTests(join(dir, "automations.json"));
    expect(hasHandledFire("ci:a:sha1")).toBe(true);
    expect(lastDispatchAt("fix-ci", "a")).not.toBeNull();
  });

  test("dropFires un-consumes declined dispatches so the condition can re-fire", () => {
    markFiresDispatched(["ci:a:sha1"], "fix-ci", "a");
    expect(hasHandledFire("ci:a:sha1")).toBe(true);
    dropFires(["ci:a:sha1", "never-recorded"]);
    expect(hasHandledFire("ci:a:sha1")).toBe(false);
  });

  test("boot reconcile flips matched dispatches and drops unmatched ones", () => {
    markFiresDispatched(["ci:a:sha1"], "fix-ci", "a");
    markFiresDispatched(["ci:b:sha9"], "fix-ci", "b");
    markFiresDelivered(["ci:b:sha9"]);
    markFiresDispatched(["rabbit:c:sha3"], "auto-rabbit", "c");
    // A run exists for the ci:a key (crash after launch) but not for
    // the rabbit key (crash before launch).
    const dropped = reconcileDispatchedFires((k) => k === "ci:a:sha1");
    expect(dropped).toBe(1);
    expect(hasHandledFire("ci:a:sha1")).toBe(true);
    expect(hasHandledFire("ci:b:sha9")).toBe(true); // delivered untouched
    expect(hasHandledFire("rabbit:c:sha3")).toBe(false); // re-fires
  });
});

describe("circuit breaker", () => {
  test("counts consecutive dispatches, trips, and resets on clear", () => {
    expect(breakerState("fix-ci", "a")).toEqual({ count: 0, trippedAt: null, updatedAt: 0 });
    expect(bumpBreaker("fix-ci", "a")).toBe(1);
    expect(bumpBreaker("fix-ci", "a")).toBe(2);
    expect(breakerState("fix-ci", "a").updatedAt).toBeGreaterThan(0);
    tripBreaker("fix-ci", "a");
    expect(breakerState("fix-ci", "a").trippedAt).not.toBeNull();
    // Condition observed clear → full reset.
    resetBreaker("fix-ci", "a");
    expect(breakerState("fix-ci", "a")).toEqual({ count: 0, trippedAt: null, updatedAt: 0 });
  });

  test("breaker state is per (rule, slug)", () => {
    bumpBreaker("fix-ci", "a");
    expect(breakerState("fix-ci", "b").count).toBe(0);
    expect(breakerState("auto-rabbit", "a").count).toBe(0);
  });
});
