import { afterEach, describe, expect, test } from "bun:test";

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCodexUsage } from "./usage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function usageLine(
  primary: { used_percent: number; window_minutes?: number; resets_at: number } | null,
  secondary: { used_percent: number; window_minutes?: number; resets_at: number } | null,
): string {
  return JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: { primary, secondary, plan_type: "pro" },
    },
  });
}

function rollout(
  datePath: string,
  line: string,
  mtimeMs = Date.now(),
): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "wt-codex-usage-"));
  roots.push(root);
  const dir = join(root, datePath);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "rollout-test.jsonl");
  writeFileSync(path, `${line}\n`);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  return { root, path };
}

describe("readCodexUsage", () => {
  test("reads a current single weekly window from the primary slot", () => {
    const { root } = rollout(
      "2026/09/04",
      usageLine(
        { used_percent: 96, window_minutes: 10_080, resets_at: 1_788_748_545 },
        null,
      ),
    );

    expect(readCodexUsage(root)).toMatchObject({
      fiveHour: null,
      sevenDay: {
        utilization: 96,
        resetsAt: "2026-09-07T02:35:45.000Z",
      },
      planType: "pro",
    });
  });

  test("reads legacy two-window payloads", () => {
    const { root } = rollout(
      "2026/09/04",
      usageLine(
        { used_percent: 25, window_minutes: 300, resets_at: 1_788_000_000 },
        { used_percent: 50, window_minutes: 10_080, resets_at: 1_788_700_000 },
      ),
    );

    expect(readCodexUsage(root)).toMatchObject({
      fiveHour: { utilization: 25 },
      sevenDay: { utilization: 50 },
    });
  });

  test("a resumed session in an old date partition can be freshest", () => {
    const now = Date.now();
    const { root } = rollout(
      "2026/01/01",
      usageLine(
        { used_percent: 88, window_minutes: 10_080, resets_at: 1_788_748_545 },
        null,
      ),
      now + 1_000,
    );
    const newerDateDir = join(root, "2026/09/04");
    mkdirSync(newerDateDir, { recursive: true });
    const newerDatePath = join(newerDateDir, "rollout-newer-date.jsonl");
    writeFileSync(
      newerDatePath,
      `${usageLine(
        { used_percent: 22, window_minutes: 10_080, resets_at: 1_788_748_545 },
        null,
      )}\n`,
    );
    utimesSync(newerDatePath, now / 1000, now / 1000);

    expect(readCodexUsage(root)?.sevenDay?.utilization).toBe(88);
  });
});
