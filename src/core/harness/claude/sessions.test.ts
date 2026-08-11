import { describe, expect, test } from "bun:test";

import { wtSessionUuid } from "./jsonl.ts";
import type { RegistrySession } from "./registry.ts";
import type { ClaudeRuntimeRegistration } from "./runtime-registry.ts";
import { createClaudeSessions } from "./sessions.ts";

const cwd = "/Users/michael/.wt";
const target = { slug: "wt", cwd, managedName: null };
const sessionId = wtSessionUuid(cwd, null);

function runtime(socketPath = "/tmp/claude-native.sock"): ClaudeRuntimeRegistration {
  return {
    version: 1,
    sessionId,
    cwd,
    socketPath,
    messagingToken: "token-1",
    registeredAt: 10,
    updatedAt: 20,
  };
}

function native(socketPath = "/tmp/claude-native.sock"): RegistrySession {
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
    messagingSocketPath: socketPath,
    peerProtocol: 1,
  };
}

function fakes() {
  let now = 100;
  let entries: ClaudeRuntimeRegistration[] = [];
  let nativeEntries: RegistrySession[] = [];
  let starts = 0;
  const writes: Array<{ path: string; frames: readonly Record<string, unknown>[] }> = [];
  const deps = {
    readRuntime: () => entries,
    pruneRuntime: (stale: ClaudeRuntimeRegistration[]) => {
      const keys = new Set(stale.map((entry) => `${entry.sessionId}:${entry.socketPath}:${entry.updatedAt}`));
      entries = entries.filter(
        (entry) => !keys.has(`${entry.sessionId}:${entry.socketPath}:${entry.updatedAt}`),
      );
    },
    unregisterRuntime: (match: { sessionId: string; socketPath?: string }) => {
      entries = entries.filter(
        (entry) =>
          entry.sessionId !== match.sessionId ||
          (match.socketPath !== undefined && entry.socketPath !== match.socketPath),
      );
    },
    readNative: () => nativeEntries,
    socketLive: async () => true,
    writeSocket: async (path: string, frames: readonly Record<string, unknown>[]) => {
      writes.push({ path, frames });
    },
    startDetached: async () => {
      starts += 1;
      entries = [runtime()];
      nativeEntries = [native()];
      return { ok: true as const };
    },
    kill: async () => {},
    version: async () => "2.1.228 (Claude Code)",
    deliveryLanded: () => true,
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      await Promise.resolve();
    },
  };
  return {
    deps,
    setEntries(next: ClaudeRuntimeRegistration[], nativeNext: RegistrySession[] = []) {
      entries = next;
      nativeEntries = nativeNext;
    },
    entries: () => entries,
    starts: () => starts,
    writes,
  };
}

describe("Claude sessions", () => {
  test("discovers a running session by stable cwd identity", async () => {
    const fake = fakes();
    fake.setEntries([runtime()], [native()]);
    const sessions = createClaudeSessions(fake.deps);

    expect(await sessions.find(target)).toMatchObject({
      sessionId,
      cwd,
      pid: 42,
      socketPath: "/tmp/claude-native.sock",
      source: "hook",
    });
  });

  test("adopts one unambiguous manually-started primary in the cwd", async () => {
    const fake = fakes();
    const manual = { ...runtime(), sessionId: "manual-session" };
    const manualNative = { ...native(), sessionId: "manual-session", name: null };
    fake.setEntries([manual], [manualNative]);
    const sessions = createClaudeSessions(fake.deps);

    expect(await sessions.find(target)).toMatchObject({ sessionId: "manual-session", cwd });
  });

  test("prunes stale registrations", async () => {
    const fake = fakes();
    fake.setEntries([runtime()]);
    const sessions = createClaudeSessions({ ...fake.deps, socketLive: async () => false });

    expect(await sessions.list()).toEqual([]);
    expect(fake.entries()).toEqual([]);
  });

  test("cold-starts once and sends the implementation-supported native frames", async () => {
    const fake = fakes();
    const sessions = createClaudeSessions(fake.deps);

    const result = await sessions.send(target, "Do the next task.");

    expect(result).toMatchObject({ ok: true, coldStarted: true, delivered: true });
    expect(fake.starts()).toBe(1);
    expect(fake.writes).toEqual([
      {
        path: "/tmp/claude-native.sock",
        frames: [
          { type: "auth", token: "token-1" },
          { type: "user", message: { role: "user", content: "Do the next task." } },
        ],
      },
    ]);
  });

  test("serializes concurrent ensure calls across the cold-start race", async () => {
    const fake = fakes();
    const sessions = createClaudeSessions(fake.deps);

    await Promise.all([sessions.ensure(target), sessions.ensure(target)]);

    expect(fake.starts()).toBe(1);
  });

  test("rejects duplicate live processes for the same stable session", async () => {
    const fake = fakes();
    fake.setEntries(
      [runtime("/tmp/one.sock"), runtime("/tmp/two.sock")],
      [native("/tmp/one.sock"), native("/tmp/two.sock")],
    );
    const sessions = createClaudeSessions(fake.deps);

    expect(sessions.find(target)).rejects.toThrow("multiple live Claude processes");
  });

  test("does not start an unsupported Claude Code version", async () => {
    const fake = fakes();
    const sessions = createClaudeSessions({ ...fake.deps, version: async () => "2.1.220" });

    expect(await sessions.send(target, "hello")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("2.1.228 or newer"),
    });
    expect(fake.starts()).toBe(0);
  });

  test("fails cleanly when a started process never publishes an inbox", async () => {
    const fake = fakes();
    const sessions = createClaudeSessions({
      ...fake.deps,
      startDetached: async () => ({ ok: true as const }),
    });

    expect(await sessions.send(target, "hello")).toMatchObject({
      ok: false,
      reason: expect.stringContaining("did not register a native messaging socket within 20s"),
    });
  });
});
