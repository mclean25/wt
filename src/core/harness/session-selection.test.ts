import { describe, expect, test } from "bun:test";

import type { HarnessSession } from "./types.ts";
import { primarySingleSlotSession } from "./session-selection.ts";

function session(
  sessionId: string,
  managedName: string | null,
  lastActiveMs: number | null,
): HarnessSession {
  return {
    displayName: managedName ?? sessionId,
    sessionId,
    tmuxSessionName: "demo-codex",
    lastActiveMs,
    isLive: false,
    extras: {
      managedName,
      derivedState: null,
      queued: 0,
    },
  };
}

describe("primarySingleSlotSession", () => {
  test("uses wt's mapped primary instead of recency", () => {
    expect(
      primarySingleSlotSession([
        session("secondary-id", "2", 3_000),
        session("primary-id", "primary", 1_000),
      ])?.sessionId,
    ).toBe("primary-id");
  });

  test("falls back to newest legacy session when no mapping is available", () => {
    expect(
      primarySingleSlotSession([
        session("older", null, 1_000),
        session("newer", null, 3_000),
      ])?.sessionId,
    ).toBe("newer");
  });
});
