import { describe, expect, test } from "bun:test";
import type { HarnessSession } from "../types.ts";
import {
  deriveCodexNativeStatus,
  enrichCodexSessionsWithNativeStatus,
  type CodexNativeThreadSnapshot,
} from "./native-status.ts";

function session(
  sessionId: string,
  derivedState: HarnessSession["extras"]["derivedState"] = "working",
): HarnessSession {
  return {
    displayName: "primary",
    sessionId,
    tmuxSessionName: "task-codex",
    lastActiveMs: 123,
    isLive: true,
    extras: {
      managedName: "primary",
      derivedState,
      queued: 4,
      waitingFor: "rollout fallback",
    },
  };
}

describe("deriveCodexNativeStatus", () => {
  test("preserves rollout fallback when native state is unavailable or not loaded", () => {
    expect(deriveCodexNativeStatus(null)).toBeNull();
    expect(deriveCodexNativeStatus(undefined)).toBeNull();
    expect(deriveCodexNativeStatus({ type: "notLoaded" })).toBeNull();
  });

  test("maps idle and active work", () => {
    expect(deriveCodexNativeStatus({ type: "idle" })).toEqual({
      derivedState: "waiting",
      waitingFor: null,
    });
    expect(
      deriveCodexNativeStatus({ type: "active", activeFlags: [] }),
    ).toEqual({ derivedState: "working", waitingFor: null });
  });

  test("maps each blocking flag and their combination", () => {
    expect(
      deriveCodexNativeStatus({
        type: "active",
        activeFlags: ["waitingOnApproval"],
      }),
    ).toEqual({ derivedState: "asking", waitingFor: "approval prompt" });
    expect(
      deriveCodexNativeStatus({
        type: "active",
        activeFlags: ["waitingOnUserInput"],
      }),
    ).toEqual({ derivedState: "asking", waitingFor: "question prompt" });
    expect(
      deriveCodexNativeStatus({
        type: "active",
        activeFlags: ["waitingOnApproval", "waitingOnUserInput"],
      }),
    ).toEqual({
      derivedState: "asking",
      waitingFor: "approval or question prompt",
    });
  });

  test("does not mistake system errors or future statuses for idle", () => {
    expect(deriveCodexNativeStatus({ type: "systemError" })).toEqual({
      derivedState: "unknown",
      waitingFor: null,
    });
    expect(
      deriveCodexNativeStatus({ type: "pausedByServer" }),
    ).toEqual({ derivedState: "unknown", waitingFor: null });
  });

  test("fails unknown active flags safely without hiding known blocking flags", () => {
    expect(
      deriveCodexNativeStatus({ type: "active", activeFlags: ["futureFlag"] }),
    ).toEqual({ derivedState: "unknown", waitingFor: null });
    expect(
      deriveCodexNativeStatus({
        type: "active",
        activeFlags: ["futureFlag", "waitingOnUserInput"],
      }),
    ).toEqual({ derivedState: "asking", waitingFor: "question prompt" });
  });
});

describe("enrichCodexSessionsWithNativeStatus", () => {
  test("merges by UUID and leaves sessions absent from the batch untouched", () => {
    const matched = session("uuid-1");
    const absent = session("uuid-2", "waiting");
    const snapshots = new Map<string, CodexNativeThreadSnapshot>([
      [
        "uuid-1",
        {
          status: { type: "active", activeFlags: ["waitingOnApproval"] },
          queued: 3,
        },
      ],
    ]);

    const result = enrichCodexSessionsWithNativeStatus(
      [matched, absent],
      snapshots,
    );

    expect(result[0]?.extras).toMatchObject({
      derivedState: "asking",
      waitingFor: "approval prompt",
      queued: 3,
    });
    expect(result[1]).toBe(absent);
  });

  test("keeps rollout state for notLoaded but still represents queue count", () => {
    const fallback = session("uuid-1", "working");
    const [result] = enrichCodexSessionsWithNativeStatus(
      [fallback],
      new Map([
        ["uuid-1", { status: { type: "notLoaded" } as const, queued: 2 }],
      ]),
    );

    expect(result?.extras).toMatchObject({
      derivedState: "working",
      waitingFor: "rollout fallback",
      queued: 2,
    });
  });

  test("normalizes invalid native queue counts", () => {
    const base = session("uuid-1");
    for (const [queued, expected] of [
      [-2, 0],
      [2.9, 2],
      [Number.NaN, 0],
    ] as const) {
      const [result] = enrichCodexSessionsWithNativeStatus(
        [base],
        new Map([
          ["uuid-1", { status: { type: "idle" } as const, queued }],
        ]),
      );
      expect(result?.extras.queued).toBe(expected);
    }
  });
});
