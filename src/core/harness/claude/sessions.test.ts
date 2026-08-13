import { describe, expect, test } from "bun:test";

import { wtSessionUuid } from "./jsonl.ts";
import type { RegistrySession } from "./registry.ts";
import { createClaudeSessions } from "./sessions.ts";

const cwd = "/Users/michael/.wt";
const target = { slug: "wt", cwd, managedName: null };
const sessionId = wtSessionUuid(cwd, null);

function native(overrides: Partial<RegistrySession> = {}): RegistrySession {
  return {
    pid: 42,
    sessionId,
    cwd,
    name: "wt",
    status: "idle",
    waitingFor: null,
    kind: "local",
    entrypoint: "cli",
    startedAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function fakes() {
  let now = 100;
  let nativeEntries: RegistrySession[] = [];
  let starts = 0;
  const deps = {
    readNative: () => nativeEntries,
    startDetached: async () => {
      starts += 1;
      nativeEntries = [native()];
      return { ok: true as const };
    },
    kill: async () => {},
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      await Promise.resolve();
    },
  };
  return {
    deps,
    setEntries(next: RegistrySession[]) {
      nativeEntries = next;
    },
    starts: () => starts,
  };
}

describe("Claude sessions", () => {
  test("discovers a running session by stable cwd identity", () => {
    const fake = fakes();
    fake.setEntries([native()]);
    const sessions = createClaudeSessions(fake.deps);

    expect(sessions.find(target)).toMatchObject({ sessionId, cwd, pid: 42, status: "idle" });
  });

  test("adopts one unambiguous manually-started primary in the cwd", () => {
    const fake = fakes();
    fake.setEntries([native({ sessionId: "manual-session", name: null })]);
    const sessions = createClaudeSessions(fake.deps);

    expect(sessions.find(target)).toMatchObject({ sessionId: "manual-session", cwd });
  });

  test("a dead session is simply absent — liveness is the registry's job", () => {
    // Claude Code leaves a state file behind on SIGKILL; `readRegistry`
    // drops it by pid. Nothing here re-checks, so nothing here can
    // disagree with the picker about what is running.
    const fake = fakes();
    fake.setEntries([]);
    const sessions = createClaudeSessions(fake.deps);

    expect(sessions.list()).toEqual([]);
    expect(sessions.find(target)).toBeNull();
  });

  test("surfaces what a session is blocked on", () => {
    // The send path refuses to type into a session in this state: the
    // submit key would answer whatever dialog is up.
    const fake = fakes();
    fake.setEntries([native({ status: "waiting", waitingFor: "permission prompt" })]);
    const sessions = createClaudeSessions(fake.deps);

    expect(sessions.find(target)).toMatchObject({
      status: "waiting",
      waitingFor: "permission prompt",
    });
  });

  test("serializes concurrent ensure calls across the cold-start race", async () => {
    const fake = fakes();
    const sessions = createClaudeSessions(fake.deps);

    await Promise.all([sessions.ensure(target), sessions.ensure(target)]);

    expect(fake.starts()).toBe(1);
  });

  test("rejects duplicate live processes for the same stable session", () => {
    const fake = fakes();
    fake.setEntries([native({ pid: 1 }), native({ pid: 2 })]);
    const sessions = createClaudeSessions(fake.deps);

    expect(() => sessions.find(target)).toThrow("multiple live Claude processes");
  });

  test("fails cleanly when a started process never registers", async () => {
    const fake = fakes();
    const sessions = createClaudeSessions({
      ...fake.deps,
      startDetached: async () => ({ ok: true as const }),
    });

    expect(sessions.ensureInfo(target)).rejects.toThrow("did not register within 20s");
  });
});
