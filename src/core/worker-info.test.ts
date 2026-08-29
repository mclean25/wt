import { describe, expect, test } from "bun:test";

import { parseWorkerInfo, WORKER_PROTOCOL_VERSION } from "./worker-info.ts";

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
});
