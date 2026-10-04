import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { checkCommunicationHold, releaseCommunicationHold, setCommunicationHold } from "./communication-holds.ts";
import { prepareHoldMessage } from "./communication-message.ts";

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("queued hold references", () => {
  test("18:40 freeze arriving at 19:11 cannot beat 19:03 release; ack replay cannot renew it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-hold-message-"));
    directories.push(dir);
    const path = join(dir, "holds.json");
    const at = (time: string) => `2026-10-02T${time}:00.000Z`;
    await Effect.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(at("18:40")));
      const hold = yield* setCommunicationHold({
        resource: "browser:19989", owner: "repair-owner", scope: "browser execution",
        eventAt: at("18:40"), until: at("19:30"), reason: "release after restart",
      }, path);
      const queued = yield* prepareHoldMessage(hold.id, "affected browser operations only", path);
      expect(queued).toContain(`wt hold check ${hold.id}`);
      expect(queued).toContain(at("18:40"));
      expect(queued).toContain("No acknowledgment requested");
      yield* TestClock.setTime(Date.parse(at("19:03")));
      yield* releaseCommunicationHold({ resource: hold.resource, owner: hold.owner, eventAt: at("19:03"), reason: "resolved" }, path);
      const released = readFileSync(path, "utf8");
      yield* TestClock.setTime(Date.parse(at("19:11")));
      // The native queue may still deliver the old text. Its exact reference
      // is checked against current state, never stamped with delivery time.
      expect((yield* checkCommunicationHold(hold.id, path)).active).toBe(false);
      const acknowledgement = yield* Effect.result(prepareHoldMessage(hold.id, "acknowledged", path));
      expect(acknowledgement._tag).toBe("Failure");
      expect(readFileSync(path, "utf8")).toBe(released);
      expect(queued).not.toContain(at("19:11"));
    }).pipe(Effect.provide(TestClock.layer())));
  });

  test("forwarding an active reference preserves the deadline and state bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-hold-forward-"));
    directories.push(dir);
    const path = join(dir, "holds.json");
    await Effect.runPromise(Effect.gen(function* () {
      yield* TestClock.setTime(60_000);
      const hold = yield* setCommunicationHold({ resource: "service", owner: "owner", scope: "service calls", eventAt: "1970-01-01T00:01:00.000Z", until: "1970-01-01T00:02:00.000Z", reason: "maintenance ends" }, path);
      const before = readFileSync(path, "utf8");
      yield* TestClock.setTime(119_000);
      const text = yield* prepareHoldMessage(hold.id, "ack", path);
      expect(text).toContain(hold.until);
      expect(readFileSync(path, "utf8")).toBe(before);
      yield* TestClock.setTime(120_000);
      expect((yield* checkCommunicationHold(hold.id, path)).active).toBe(false);
    }).pipe(Effect.provide(TestClock.layer())));
  });
});
