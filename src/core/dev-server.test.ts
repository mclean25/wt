import { describe, expect, test } from "bun:test";
import net from "node:net";

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  decideDevSlot,
  probePort,
  readDevWaiters,
  type DevSlotHolder,
} from "./dev-server.ts";

/** Hold the event loop hostage the way a heavy sync render does. */
function blockLoop(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // spin
  }
}

async function withListener<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = net.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  try {
    return await fn(port);
  } finally {
    server.close();
  }
}

/** A port nothing is listening on: bind one, then release it. */
async function closedPort(): Promise<number> {
  const server = net.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("probePort", () => {
  test("reports a listening port", async () => {
    await withListener(async (port) => {
      expect(await probePort(port)).toBe("listening");
    });
  });

  test("reports a closed port free (refused, not timed out)", async () => {
    expect(await probePort(await closedPort())).toBe("free");
  });

  // The bug this whole three-state probe exists for: libuv runs timers
  // before poll, so an event loop blocked past the deadline fires the
  // timeout callback ahead of a `connect` that already succeeded. The
  // old boolean probe returned false there — a live dev server read as
  // dead and the bolt vanished from the row.
  test("never reports a listening port free when the loop stalls past the deadline", async () => {
    await withListener(async (port) => {
      const probe = probePort(port, 100);
      blockLoop(300);
      expect(await probe).not.toBe("free");
    });
  });

  test("retry resolves a stall-induced inconclusive probe", async () => {
    await withListener(async (port) => {
      const probe = probePort(port, 100);
      blockLoop(300);
      // First attempt times out mid-stall; the second runs on a loop
      // that is moving again and gets the real answer.
      expect(await probe).toBe("listening");
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrency slots
// ---------------------------------------------------------------------------

/**
 * A pid that cannot exist. macOS caps pids at 99999 (`kern.maxproc`
 * ceiling), so this is a deterministic dead process — better than
 * spawning something and reusing its pid, which a busy machine could
 * recycle inside the test.
 */
const DEAD_PID = 999_999;

describe("decideDevSlot", () => {
  const up = (slug: string): DevSlotHolder => ({ slug, state: "up" });

  test("no cap configured means every start proceeds", () => {
    const d = decideDevSlot("mine", [up("a"), up("b"), up("c")], null);
    expect(d.ok).toBe(true);
    expect(d.free).toBeNull();
  });

  test("refuses once the cap is reached", () => {
    const d = decideDevSlot("mine", [up("a"), up("b")], 2);
    expect(d.ok).toBe(false);
    expect(d.free).toBe(0);
    expect(d.holders.map((h) => h.slug)).toEqual(["a", "b"]);
  });

  // Start is also restart. A worktree already holding a slot is not
  // asking for a second one, and refusing it would make a full fleet
  // unable to pick up a config edit.
  test("the asking slug never counts against itself", () => {
    const d = decideDevSlot("mine", [up("a"), up("mine")], 2);
    expect(d.ok).toBe(true);
    expect(d.free).toBe(1);
    expect(d.holders.map((h) => h.slug)).toEqual(["a"]);
  });

  // A parked supervisor is a holder like any other: the containers and
  // tunnels its command created outside its own process tree are still
  // up, and those are what the cap rations.
  test("a crashed server still holds its slot", () => {
    const d = decideDevSlot("mine", [{ slug: "a", state: "crashed" }], 1);
    expect(d.ok).toBe(false);
    expect(d.holders[0]!.state).toBe("crashed");
  });

  test("free never goes negative when the fleet is over the cap", () => {
    const d = decideDevSlot("mine", [up("a"), up("b"), up("c")], 2);
    expect(d.free).toBe(0);
  });
});

describe("readDevWaiters", () => {
  function queueDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "wt-devqueue-"));
    return dir;
  }
  const write = (dir: string, slug: string, rec: unknown) =>
    writeFileSync(join(dir, `${slug}.json`), JSON.stringify(rec));

  test("returns live waiters oldest first", () => {
    const dir = queueDir();
    write(dir, "later", { pid: process.pid, since: 2000 });
    write(dir, "earlier", { pid: process.pid, since: 1000 });
    expect(readDevWaiters(dir).map((w) => w.slug)).toEqual(["earlier", "later"]);
  });

  // The self-expiring half. Nothing ever has to remember to leave the
  // queue: a waiter killed outright leaves a file that the next reader
  // discards, which is what keeps a slot ledger from drifting.
  test("drops and deletes the entry of a process that is gone", () => {
    const dir = queueDir();
    write(dir, "dead", { pid: DEAD_PID, since: 1000 });
    write(dir, "alive", { pid: process.pid, since: 2000 });
    expect(readDevWaiters(dir).map((w) => w.slug)).toEqual(["alive"]);
    expect(existsSync(join(dir, "dead.json"))).toBe(false);
    expect(existsSync(join(dir, "alive.json"))).toBe(true);
  });

  test("discards torn or hand-edited files rather than throwing", () => {
    const dir = queueDir();
    writeFileSync(join(dir, "torn.json"), "{not json");
    write(dir, "nopid", { since: 1000 });
    write(dir, "good", { pid: process.pid, since: 1000 });
    expect(readDevWaiters(dir).map((w) => w.slug)).toEqual(["good"]);
    expect(existsSync(join(dir, "torn.json"))).toBe(false);
    expect(existsSync(join(dir, "nopid.json"))).toBe(false);
  });

  test("an absent queue directory is an empty queue, not an error", () => {
    expect(readDevWaiters(join(tmpdir(), "wt-devqueue-does-not-exist"))).toEqual([]);
  });
});
