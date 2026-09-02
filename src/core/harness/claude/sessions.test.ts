import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

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
    // Hermetic: without this the shared defaults supply the real
    // `capturePane`, so a unit test spawns tmux on its failure path.
    peekPane: async () => null,
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

    await Promise.all([sessions.ensurePromise(target), sessions.ensurePromise(target)]);

    expect(fake.starts()).toBe(1);
  });

  test("interrupting a cold start releases the per-session lock", async () => {
    let calls = 0;
    let entries: RegistrySession[] = [];
    const sessions = createClaudeSessions({
      readNative: () => entries,
      startDetached: async () => {
        calls += 1;
        if (calls === 1) return await new Promise(() => {});
        entries = [native()];
        return { ok: true as const };
      },
      kill: async () => {},
      peekPane: async () => null,
      now: Date.now,
      sleep: async () => {},
    });

    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Effect.forkChild(sessions.ensureInfo(target));
      while (calls === 0) yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      const second = yield* sessions.ensureInfo(target);
      expect(second.session.sessionId).toBe(sessionId);
      expect(calls).toBe(2);
    }));
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

    expect(sessions.ensureInfoPromise(target)).rejects.toThrow("did not register within 20s");
  });
});

describe("a pre-existing dead session", () => {
  const target = { slug: "demo", cwd: "/tmp/demo-wt", managedName: null };

  /**
   * The shape observed in the field: tmux already has a session by this
   * name, so `new-session` refuses and the start ADOPTS it — creating
   * nothing. Nothing ever registers, so every attempt waits out the
   * full timeout and reports a timing error, and the retry re-adopts
   * the same corpse. Two attempts 42 seconds apart are in the log.
   */
  function stuckAdoption(opts: { registersAfterKill: boolean }) {
    let killed = false;
    let starts = 0;
    let now = 100;
    let entries: RegistrySession[] = [];
    return {
      get starts() {
        return starts;
      },
      get killed() {
        return killed;
      },
      deps: {
        readNative: () => entries,
        startDetached: async () => {
          starts += 1;
          // Adopted every time until the session is torn down.
          if (!killed) return { ok: true as const, adopted: true };
          if (opts.registersAfterKill) {
            entries = [
              native({ cwd: "/tmp/demo-wt", name: "demo" }),
            ];
          }
          return { ok: true as const };
        },
        kill: async () => {
          killed = true;
        },
        peekPane: async () => "some stuck output\nlast line",
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
          await Promise.resolve();
        },
      },
    };
  }

  test("is torn down and recreated instead of waited out again", async () => {
    const fake = stuckAdoption({ registersAfterKill: true });
    const sessions = createClaudeSessions(fake.deps);

    await sessions.ensureInfoPromise(target);

    expect(fake.killed).toBe(true);
    expect(fake.starts).toBe(2);
  });

  // The whole point: the caller gets a working session, not advice.
  test("recovers without the caller running `wt claude stop` first", async () => {
    const fake = stuckAdoption({ registersAfterKill: true });
    const sessions = createClaudeSessions(fake.deps);

    const { session } = await sessions.ensureInfoPromise(target);
    expect(session.cwd).toBe("/tmp/demo-wt");
  });

  // When recycling doesn't help either, the error must not still read
  // as a timing problem you fix by waiting — that framing is what sent
  // a reader down the retry path twice.
  test("says what it tried, and quotes the pane, when recycling fails too", async () => {
    const fake = stuckAdoption({ registersAfterKill: false });
    const sessions = createClaudeSessions(fake.deps);

    expect(sessions.ensureInfoPromise(target)).rejects.toThrow(/recycling the pre-existing/);
  });

  // A session this call genuinely CREATED is a different failure: the
  // harness itself did not come up, and killing/recreating it would
  // just reproduce that. Recycle only what we adopted.
  test("a freshly created session that never registers is not recycled", async () => {
    let killed = false;
    let now = 100;
    const sessions = createClaudeSessions({
      readNative: () => [],
      startDetached: async () => ({ ok: true as const }),
      kill: async () => {
        killed = true;
      },
      peekPane: async () => "",
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
        await Promise.resolve();
      },
    });

    expect(sessions.ensureInfoPromise(target)).rejects.toThrow("did not register within 20s");
    expect(killed).toBe(false);
  });

  // The pane is the only place a refusing harness explains itself, and
  // "empty" is itself the answer to the first question a reader has.
  test("an empty pane is reported as empty rather than omitted", async () => {
    let now = 100;
    const sessions = createClaudeSessions({
      readNative: () => [],
      startDetached: async () => ({ ok: true as const }),
      kill: async () => {},
      peekPane: async () => "   \n\n",
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
        await Promise.resolve();
      },
    });

    expect(sessions.ensureInfoPromise(target)).rejects.toThrow(/pane is empty/);
  });
});
