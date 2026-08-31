import { describe, expect, test } from "bun:test";

import type { HarnessSession } from "../../core/harness/index.ts";

import { slotSessionResumeTarget } from "./sessions.ts";

function session(sessionId: string, lastActiveMs: number | null): HarnessSession {
  return {
    displayName: sessionId,
    sessionId,
    tmuxSessionName: "slot-codex",
    lastActiveMs,
    isLive: false,
    extras: {
      managedName: null,
      derivedState: null,
      queued: 0,
    },
  };
}

function managedSession(
  sessionId: string,
  managedName: string,
  lastActiveMs: number,
): HarnessSession {
  const value = session(sessionId, lastActiveMs);
  return { ...value, extras: { ...value.extras, managedName } };
}

describe("slotSessionResumeTarget", () => {
  test("does not resume multi-slot harnesses", () => {
    expect(
      slotSessionResumeTarget({ singleSlot: false }, false, [
        session("existing", 200),
      ]),
    ).toEqual({ resumeSessionId: null, freshSlot: false });
  });

  test("attaches to a live single-slot harness without resume argv", () => {
    expect(
      slotSessionResumeTarget({ singleSlot: true }, true, [
        session("existing", 200),
      ]),
    ).toEqual({ resumeSessionId: null, freshSlot: false });
  });

  test("resumes the mapped primary even when another session is newer", () => {
    expect(
      slotSessionResumeTarget({ singleSlot: true }, false, [
        managedSession("primary-id", "primary", 100),
        managedSession("newer-id", "2", 300),
      ]),
    ).toEqual({ resumeSessionId: "primary-id", freshSlot: true });
  });

  test("falls back to newest when old discovery data has no wt mapping", () => {
    expect(
      slotSessionResumeTarget({ singleSlot: true }, false, [
        session("older", 100),
        session("newer", 300),
      ]),
    ).toEqual({ resumeSessionId: "newer", freshSlot: true });
  });

  test("starts fresh when a closed single-slot harness has no history", () => {
    expect(slotSessionResumeTarget({ singleSlot: true }, false, [])).toEqual({
      resumeSessionId: null,
      freshSlot: false,
    });
  });
});
