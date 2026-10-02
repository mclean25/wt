import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  checkCommunicationHold,
  getCommunicationHold,
  releaseCommunicationHold,
  setCommunicationHold,
  type SetCommunicationHoldInput,
} from "./communication-holds.ts";
import { withAsyncFileLock } from "./locks.ts";

let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "wt-communication-holds-"));
  path = join(directory, "holds.json");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const time = (value: string) => `2026-10-02T${value}:00.000Z`;
const input: SetCommunicationHoldInput = {
  resource: "host/codex-runtime",
  scope: "runtime restart",
  owner: "wt-runtime-fix",
  eventAt: time("18:40"),
  until: time("19:25"),
  reason: "verifying a runtime repair",
};
const release = {
  resource: input.resource,
  owner: input.owner,
  eventAt: time("19:03"),
  reason: "verification complete",
};

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())));
}

describe("communication hold event ordering", () => {
  test("the 18:40 hold delivered at 19:11 cannot undo the 19:03 release", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(input.eventAt));
      const hold = yield* setCommunicationHold(input, path);
      yield* TestClock.setTime(Date.parse(release.eventAt));
      yield* releaseCommunicationHold(release, path);
      const released = readFileSync(path, "utf8");
      yield* TestClock.setTime(Date.parse(time("19:11")));
      const error = yield* setCommunicationHold(input, path).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "CommunicationHoldError", code: "stale" });
      expect(yield* checkCommunicationHold(hold.id, path)).toMatchObject({ active: false, hold: null });
      expect(readFileSync(path, "utf8")).toBe(released);
    }));
  });

  test("a release received first durably rejects an older or equal delayed hold", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(release.eventAt));
      yield* releaseCommunicationHold(release, path);
      yield* setCommunicationHold({ ...input, resource: "host/another-resource" }, path);
      yield* TestClock.setTime(Date.parse("2027-10-02T19:11:00.000Z"));
      for (const eventAt of [input.eventAt, release.eventAt]) {
        const error = yield* setCommunicationHold({ ...input, eventAt }, path).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "stale" });
      }
      expect(yield* getCommunicationHold(input.resource, path)).toMatchObject({ active: false, hold: null });
      const stored = JSON.parse(readFileSync(path, "utf8"));
      expect(stored.events).toHaveLength(2);
      expect(stored.events[0]).toEqual({ kind: "release", release });
    }));
  });

  test("checks and exact replay never write or renew, including at the exact deadline", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(input.eventAt));
      const hold = yield* setCommunicationHold(input, path);
      const content = readFileSync(path, "utf8");
      utimesSync(path, 1, 1);
      yield* TestClock.setTime(Date.parse(input.until) - 1);
      for (let i = 0; i < 3; i++) {
        expect(yield* checkCommunicationHold(hold.id, path)).toMatchObject({ active: true, hold });
        expect(yield* setCommunicationHold(input, path)).toEqual(hold);
      }
      yield* TestClock.adjust(1);
      expect(yield* checkCommunicationHold(hold.id, path)).toMatchObject({ active: false, hold });
      expect(yield* setCommunicationHold(input, path)).toEqual(hold);
      expect(yield* checkCommunicationHold(hold.id, path)).toMatchObject({ active: false });
      expect(readFileSync(path, "utf8")).toBe(content);
      expect(statSync(path).mtimeMs).toBe(1000);
    }));
  });

  test("an active hold rejects both another owner and a new event from the same owner", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(time("18:42")));
      const hold = yield* setCommunicationHold(input, path);
      for (const owner of [input.owner, "competing-agent"]) {
        const error = yield* setCommunicationHold({ ...input, owner, eventAt: time("18:41") }, path).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "active" });
      }
      const ownerError = yield* releaseCommunicationHold({ ...release, owner: "competing-agent", eventAt: time("18:42") }, path).pipe(Effect.flip);
      expect(ownerError).toMatchObject({ code: "owner" });
      expect(yield* checkCommunicationHold(hold.id, path)).toMatchObject({ active: true, hold });
    }));
  });

  test("a release wins equal event time and an equal release is a no-write replay", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(input.eventAt));
      const hold = yield* setCommunicationHold(input, path);
      const equalRelease = { ...release, eventAt: input.eventAt };
      yield* releaseCommunicationHold(equalRelease, path);
      utimesSync(path, 1, 1);
      yield* releaseCommunicationHold(equalRelease, path);
      const error = yield* setCommunicationHold(input, path).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "stale" });
      expect(yield* checkCommunicationHold(hold.id, path)).toMatchObject({ active: false });
      expect(statSync(path).mtimeMs).toBe(1000);
    }));
  });

  test("a late release cannot clear a newer hold", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(release.eventAt));
      yield* setCommunicationHold(input, path);
      yield* releaseCommunicationHold(release, path);
      yield* TestClock.setTime(Date.parse(time("19:04")));
      const newer = yield* setCommunicationHold({ ...input, eventAt: time("19:04"), until: time("19:30") }, path);
      const error = yield* releaseCommunicationHold(release, path).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "stale" });
      expect(yield* checkCommunicationHold(newer.id, path)).toMatchObject({ active: true });
    }));
  });

  test("a hold after expiry needs a strictly newer event and supersedes the old identifier", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(input.eventAt));
      const old = yield* setCommunicationHold(input, path);
      yield* TestClock.setTime(Date.parse(input.until));
      const error = yield* setCommunicationHold({ ...input, until: time("19:40") }, path).pipe(Effect.flip);
      expect(error).toMatchObject({ code: "stale" });
      const newer = yield* setCommunicationHold({ ...input, eventAt: input.until, until: time("19:40") }, path);
      expect(newer.id).not.toBe(old.id);
      expect(yield* checkCommunicationHold(old.id, path)).toMatchObject({ active: false, hold: null });
      expect(yield* checkCommunicationHold(newer.id, path)).toMatchObject({ active: true });
    }));
  });
});

describe("communication hold storage and validation", () => {
  test("missing-store checks create no files or directories", async () => {
    const missing = join(directory, "missing", "holds.json");
    expect(await run(checkCommunicationHold("0".repeat(64), missing))).toMatchObject({ active: false, hold: null });
    expect(await run(getCommunicationHold(input.resource, missing))).toMatchObject({ active: false, hold: null });
    expect(existsSync(join(directory, "missing"))).toBe(false);
  });

  test("roundtrip uses stable SHA-256 identity and normalizes ISO offsets", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(input.eventAt));
      const hold = yield* setCommunicationHold(input, path);
      expect(hold.id).toMatch(/^[a-f0-9]{64}$/);
      expect(yield* getCommunicationHold(input.resource, path)).toEqual({ active: true, reason: input.reason, hold });
      const replay = yield* setCommunicationHold({ ...input, eventAt: "2026-10-02T11:40:00-07:00" }, path);
      expect(replay).toEqual(hold);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }));
  });

  test("concurrent updates to distinct resources preserve every record", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(input.eventAt));
      const resources = Array.from({ length: 8 }, (_, i) => `host/resource-${i}`);
      const holds = yield* Effect.all(resources.map((resource) => setCommunicationHold({ ...input, resource }, path)), { concurrency: "unbounded" });
      for (const hold of holds) {
        expect(yield* checkCommunicationHold(hold.id, path)).toMatchObject({ active: true, hold });
      }
      expect(JSON.parse(readFileSync(path, "utf8")).events).toHaveLength(resources.length);
    }));
  });

  test("a writer waits for the shared-directory lock before reading existing state", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(input.eventAt));
      const first = yield* setCommunicationHold(input, join(directory, "source.json"));
      const acquired = yield* Deferred.make<void>();
      const releaseLock = yield* Deferred.make<void>();
      const holder = yield* withAsyncFileLock("holds.json", Effect.gen(function* () {
        yield* Deferred.succeed(acquired, undefined);
        yield* Deferred.await(releaseLock);
        writeFileSync(path, JSON.stringify({ version: 1, events: [{ kind: "hold", hold: first }] }));
      }), { directory }).pipe(Effect.forkChild);
      yield* Deferred.await(acquired);
      let completed = false;
      const writer = yield* setCommunicationHold({ ...input, resource: "host/another-resource" }, path).pipe(
        Effect.tap(() => Effect.sync(() => { completed = true; })),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      expect(completed).toBe(false);
      expect(existsSync(path)).toBe(false);
      yield* Deferred.succeed(releaseLock, undefined);
      yield* Fiber.join(holder);
      yield* TestClock.adjust(1000);
      const second = yield* Fiber.join(writer);
      expect(yield* checkCommunicationHold(first.id, path)).toMatchObject({ active: true });
      expect(yield* checkCommunicationHold(second.id, path)).toMatchObject({ active: true });
    }).pipe(Effect.scoped));
  });

  test("invalid fields, future events, and deadlines outside the one-hour bound fail", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(input.eventAt));
      const invalid: SetCommunicationHoldInput[] = [
        { ...input, resource: "" },
        { ...input, scope: " " },
        { ...input, owner: " padded" },
        { ...input, reason: "two\nlines" },
        { ...input, eventAt: "2026-02-30T18:40:00Z" },
        { ...input, eventAt: "2026-10-02T18:40:00" },
        { ...input, eventAt: time("18:41") },
        { ...input, until: input.eventAt },
        { ...input, until: time("19:41") },
        { ...input, unknown: true } as SetCommunicationHoldInput,
      ];
      for (const candidate of invalid) {
        const error = yield* setCommunicationHold(candidate, path).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "CommunicationHoldError", code: "invalid" });
      }
      expect(yield* releaseCommunicationHold(release, path).pipe(Effect.flip)).toMatchObject({ code: "invalid" });
      expect(yield* checkCommunicationHold("unstructured prose", path).pipe(Effect.flip)).toMatchObject({ code: "invalid" });
      expect(existsSync(path)).toBe(false);
    }));
  });

  test("an already expired first delivery remains inactive", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(time("19:30")));
      const hold = yield* setCommunicationHold(input, path);
      expect(yield* checkCommunicationHold(hold.id, path)).toMatchObject({ active: false });
    }));
  });

  test("corrupt or unsupported storage fails closed without rewriting it", async () => {
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(release.eventAt));
      const validHold = yield* setCommunicationHold(input, path);
      const invalidStores = [
        "{",
        JSON.stringify({ version: 2, events: [] }),
        JSON.stringify({ version: 1, events: [], unknown: true }),
        JSON.stringify({ version: 1, events: [{ kind: "release", release: { ...release, owner: "" } }] }),
        JSON.stringify({ version: 1, events: [{ kind: "hold", hold: { ...validHold, id: "0".repeat(64) } }] }),
        JSON.stringify({ version: 1, events: [{ kind: "release", release }, { kind: "release", release }] }),
      ];
      for (const content of invalidStores) {
        writeFileSync(path, content);
        const operations = [
          checkCommunicationHold("0".repeat(64), path).pipe(Effect.asVoid),
          getCommunicationHold(input.resource, path).pipe(Effect.asVoid),
          setCommunicationHold(input, path).pipe(Effect.asVoid),
          releaseCommunicationHold(release, path),
        ];
        for (const operation of operations) {
          expect(yield* operation.pipe(Effect.flip)).toMatchObject({ _tag: "OperationError" });
          expect(readFileSync(path, "utf8")).toBe(content);
        }
      }
    }));
  });

  test("unreadable storage is an error rather than an empty store", async () => {
    mkdirSync(path);
    await run(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(input.eventAt));
      expect(yield* checkCommunicationHold("0".repeat(64), path).pipe(Effect.flip)).toMatchObject({ _tag: "OperationError" });
      expect(yield* setCommunicationHold(input, path).pipe(Effect.flip)).toMatchObject({ _tag: "OperationError" });
      expect(statSync(path).isDirectory()).toBe(true);
    }));
  });
});
