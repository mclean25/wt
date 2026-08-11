import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  pruneClaudeRuntimeRegistrations,
  readClaudeRuntimeRegistry,
  registerClaudeRuntime,
  unregisterClaudeRuntime,
} from "./runtime-registry.ts";

const dirs: string[] = [];

function registryPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-claude-runtime-registry-"));
  dirs.push(dir);
  return join(dir, "registry.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Claude runtime registry", () => {
  test("atomically upserts registrations and protects the token", () => {
    const path = registryPath();
    const registration = {
      sessionId: "session-1",
      cwd: "/tmp/worktree",
      socketPath: "/tmp/claude.sock",
      messagingToken: "secret-token",
    };

    registerClaudeRuntime(registration, { path, now: 10 });
    registerClaudeRuntime({ ...registration, messagingToken: "new-token" }, { path, now: 20 });

    expect(readClaudeRuntimeRegistry(path)).toEqual([
      {
        version: 1,
        ...registration,
        messagingToken: "new-token",
        registeredAt: 10,
        updatedAt: 20,
      },
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).not.toContain("secret-token");
  });

  test("unregister removes only the matching process socket", () => {
    const path = registryPath();
    const base = { sessionId: "session-1", cwd: "/tmp/worktree", messagingToken: null };
    registerClaudeRuntime({ ...base, socketPath: "/tmp/one.sock" }, { path, now: 10 });
    registerClaudeRuntime({ ...base, socketPath: "/tmp/two.sock" }, { path, now: 11 });

    unregisterClaudeRuntime({ sessionId: "session-1", socketPath: "/tmp/one.sock" }, { path });

    expect(readClaudeRuntimeRegistry(path).map((entry) => entry.socketPath)).toEqual([
      "/tmp/two.sock",
    ]);
  });

  test("stale pruning preserves a registration refreshed after the snapshot", () => {
    const path = registryPath();
    const registration = {
      sessionId: "session-1",
      cwd: "/tmp/worktree",
      socketPath: "/tmp/claude.sock",
      messagingToken: null,
    };
    registerClaudeRuntime(registration, { path, now: 10 });
    const staleSnapshot = readClaudeRuntimeRegistry(path);
    registerClaudeRuntime(registration, { path, now: 20 });

    pruneClaudeRuntimeRegistrations(staleSnapshot, { path });

    expect(readClaudeRuntimeRegistry(path)).toHaveLength(1);
    expect(readClaudeRuntimeRegistry(path)[0]?.updatedAt).toBe(20);
  });
});
