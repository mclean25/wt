import { describe, expect, test } from "bun:test";

import type { HarnessSession } from "../../core/harness/index.ts";

import { computeHarnessSessions } from "./useHarnessSessions.ts";

function codexSession(
  sessionId: string,
  derivedState: HarnessSession["extras"]["derivedState"],
  lastActiveMs = 1_000,
  managedName: string | null = null,
): HarnessSession {
  return {
    displayName: sessionId,
    sessionId,
    tmuxSessionName: "demo-codex",
    lastActiveMs,
    isLive: false,
    extras: {
      managedName,
      derivedState,
      queued: 0,
      tailEndedAt: lastActiveMs,
    },
  };
}

describe("computeHarnessSessions single-slot state normalization", () => {
  test("closed Codex session with a clean last turn is idle", () => {
    const result = computeHarnessSessions(
      new Map([["codex", [codexSession("clean", "waiting")]]]),
      new Set(),
      "demo",
      "codex",
      10_000,
    );

    expect(result.f12Target?.extras.derivedState).toBe("idle");
  });

  test("closed Codex session that was mid-turn is abandoned", () => {
    const result = computeHarnessSessions(
      new Map([["codex", [codexSession("mid-turn", "working")]]]),
      new Set(),
      "demo",
      "codex",
      10_000,
    );

    expect(result.f12Target?.extras.derivedState).toBe("abandoned");
  });

  test("live Codex session without a persisted tail is waiting", () => {
    const result = computeHarnessSessions(
      new Map([["codex", [codexSession("fresh", null)]]]),
      new Set(["demo-codex"]),
      "demo",
      "codex",
      10_000,
    );

    expect(result.f12Target?.isLive).toBe(true);
    expect(result.f12Target?.extras.derivedState).toBe("waiting");
  });

  test("closed Codex F12 target is wt's primary, not the newest session", () => {
    const result = computeHarnessSessions(
      new Map([
        [
          "codex",
          [
            codexSession("secondary-id", "waiting", 3_000, "2"),
            codexSession("primary-id", "waiting", 1_000, "primary"),
          ],
        ],
      ]),
      new Set(),
      "demo",
      "codex",
      10_000,
    );

    expect(result.f12Target?.sessionId).toBe("primary-id");
    expect(result.f12Target?.displayName).toBe("primary-id");
  });

  test("live selected primary harness wins over a newer live secondary harness", () => {
    const claude = codexSession("claude-id", "waiting", 5_000);
    claude.tmuxSessionName = "demo";
    const result = computeHarnessSessions(
      new Map([
        ["claude", [claude]],
        ["codex", [codexSession("codex-id", "working", 1_000, "primary")]],
      ]),
      new Set(["demo", "demo-codex"]),
      "demo",
      "codex",
      10_000,
    );

    expect(result.f12Target?.harnessId).toBe("codex");
    expect(result.f12Target?.sessionId).toBe("codex-id");
  });
});
