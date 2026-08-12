import { describe, expect, test } from "bun:test";
import net from "node:net";

import { probePort } from "./dev-server.ts";

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
