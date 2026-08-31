import { describe, expect, test } from "bun:test";

import type { RemoteConfig } from "./config.ts";
import {
  createWorkerInfoFetcher,
  parseWorkerInfo,
  WORKER_PROTOCOL_VERSION,
  type WorkerInfo,
} from "./worker-info.ts";

const remote: RemoteConfig = {
  host: "worker.example",
  label: "worker",
  wtPath: "~/.wt/bin/wt",
};

describe("worker handshake", () => {
  test("parses role, protocol, and build independently", () => {
    expect(parseWorkerInfo(JSON.stringify({
      role: "worker",
      protocol: WORKER_PROTOCOL_VERSION,
      build: "abc1234-dirty (2026-08-28)",
    }))).toEqual({
      role: "worker",
      protocol: WORKER_PROTOCOL_VERSION,
      build: "abc1234-dirty (2026-08-28)",
    });
  });

  test("rejects a payload without a protocol version", () => {
    expect(() => parseWorkerInfo('{"role":"worker","build":"abc"}')).toThrow(
      "protocol version",
    );
  });

  test("a refresh replaces the cached build and deduplicates concurrent loads", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const fetcher = createWorkerInfoFetcher(async () => {
      calls += 1;
      if (calls === 2) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return {
        role: "worker",
        protocol: WORKER_PROTOCOL_VERSION,
        build: `build-${calls}`,
      } satisfies WorkerInfo;
    });

    expect((await fetcher.fetch(remote)).build).toBe("build-1");
    expect((await fetcher.fetch(remote)).build).toBe("build-1");
    expect(calls).toBe(1);

    const firstRefresh = fetcher.refresh(remote);
    const secondRefresh = fetcher.refresh(remote);
    expect(calls).toBe(2);
    release?.();

    expect(await firstRefresh).toEqual(await secondRefresh);
    expect((await fetcher.fetch(remote)).build).toBe("build-2");
    expect(calls).toBe(2);
  });
});
