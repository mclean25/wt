import { lstatSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";

import { withAsyncFileLock } from "../../locks.ts";
import {
  killHarnessSession,
  startHarnessSessionDetached,
} from "../../tmux.ts";
import { promptLandedForSession, wtSessionUuid } from "./jsonl.ts";
import { claudeTmuxName } from "./harness.ts";
import { readRegistry, type RegistryStatus } from "./registry.ts";
import {
  pruneClaudeRuntimeRegistrations,
  readClaudeRuntimeRegistry,
  unregisterClaudeRuntime,
  type ClaudeRuntimeRegistration,
} from "./runtime-registry.ts";

const MIN_NATIVE_VERSION = [2, 1, 228] as const;
const START_TIMEOUT_MS = 20_000;
const START_POLL_MS = 200;
const DELIVERY_TIMEOUT_MS = 8_000;
const DELIVERY_POLL_MS = 200;
const SOCKET_TIMEOUT_MS = 1_000;
const MAX_SOCKET_PAYLOAD_BYTES = 1024 * 1024;

export type ClaudeSessionTarget = {
  slug: string;
  cwd: string;
  managedName?: string | null;
};

export type ClaudeSessionInfo = {
  sessionId: string;
  cwd: string;
  name: string | null;
  pid: number | null;
  socketPath: string;
  messagingToken: string | null;
  status: RegistryStatus;
  startedAt: number;
  updatedAt: number;
  source: "hook" | "claude-registry";
};

export type ClaudeSendResult =
  | {
      ok: true;
      coldStarted: boolean;
      delivered: boolean;
      resent: false;
      session: ClaudeSessionInfo;
    }
  | { ok: false; reason: string };

export type ClaudeSession = ClaudeSessionInfo & {
  send(text: string): Promise<ClaudeSendResult>;
  stop(): Promise<void>;
};

type Dependencies = {
  readRuntime(): ClaudeRuntimeRegistration[];
  pruneRuntime(entries: ClaudeRuntimeRegistration[]): void;
  unregisterRuntime(match: { sessionId: string; socketPath?: string }): void;
  readNative: typeof readRegistry;
  socketLive(path: string): Promise<boolean>;
  writeSocket(path: string, frames: readonly Record<string, unknown>[]): Promise<void>;
  startDetached(
    slug: string,
    cwd: string,
    harnessId: "claude",
    managedName: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  kill(slug: string, harnessId: "claude", managedName: string | null): Promise<void>;
  version(): Promise<string>;
  deliveryLanded(cwd: string, sessionId: string, text: string, sinceMs: number): boolean;
  now(): number;
  sleep(ms: number): Promise<void>;
};

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function socketFileExists(path: string): boolean {
  try {
    return lstatSync(path).isSocket();
  } catch {
    return false;
  }
}

async function defaultSocketLive(path: string): Promise<boolean> {
  if (!socketFileExists(path)) return false;
  return await new Promise<boolean>((done) => {
    const socket = createConnection({ path });
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(value);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

async function defaultWriteSocket(
  path: string,
  frames: readonly Record<string, unknown>[],
): Promise<void> {
  const payload = `${frames.map((frame) => JSON.stringify(frame)).join("\n")}\n`;
  if (Buffer.byteLength(payload) >= MAX_SOCKET_PAYLOAD_BYTES) {
    throw new Error("Claude native message exceeds the 1 MiB socket protocol limit");
  }
  await new Promise<void>((done, fail) => {
    const socket = createConnection({ path });
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) fail(err);
      else done();
    };
    socket.once("connect", () => socket.end(payload));
    socket.once("error", finish);
    socket.once("close", (hadError) => {
      if (!hadError) finish();
    });
    socket.setTimeout(SOCKET_TIMEOUT_MS, () =>
      finish(new Error("timed out writing Claude messaging socket")),
    );
  });
}

async function installedClaudeVersion(): Promise<string> {
  const proc = Bun.spawn(["claude", "--version"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr.trim() || `claude --version exited ${code}`);
  return stdout.trim();
}

const defaults: Dependencies = {
  readRuntime: readClaudeRuntimeRegistry,
  pruneRuntime: pruneClaudeRuntimeRegistrations,
  unregisterRuntime: unregisterClaudeRuntime,
  readNative: readRegistry,
  socketLive: defaultSocketLive,
  writeSocket: defaultWriteSocket,
  startDetached: startHarnessSessionDetached,
  kill: killHarnessSession,
  version: installedClaudeVersion,
  deliveryLanded: promptLandedForSession,
  now: Date.now,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

function versionAtLeast(raw: string, minimum = MIN_NATIVE_VERSION): boolean {
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let i = 0; i < minimum.length; i += 1) {
    if (actual[i]! > minimum[i]!) return true;
    if (actual[i]! < minimum[i]!) return false;
  }
  return true;
}

export function createClaudeSessions(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { ...defaults, ...overrides };

  async function list(): Promise<ClaudeSessionInfo[]> {
    const runtime = deps.readRuntime();
    const liveRuntime = (
      await Promise.all(
        runtime.map(async (entry) => ({ entry, live: await deps.socketLive(entry.socketPath) })),
      )
    ).filter(({ live }) => live).map(({ entry }) => entry);
    const liveSockets = new Set(liveRuntime.map((entry) => entry.socketPath));
    deps.pruneRuntime(runtime.filter((entry) => !liveSockets.has(entry.socketPath)));

    const runtimeBySocket = new Map(liveRuntime.map((entry) => [entry.socketPath, entry]));
    const out = new Map<string, ClaudeSessionInfo>();
    for (const native of deps.readNative()) {
      const socketPath = native.messagingSocketPath;
      if (!socketPath || !(await deps.socketLive(socketPath))) continue;
      const hook = runtimeBySocket.get(socketPath);
      out.set(socketPath, {
        sessionId: native.sessionId,
        cwd: canonical(native.cwd),
        name: native.name,
        pid: native.pid,
        socketPath,
        messagingToken: hook?.messagingToken ?? null,
        status: native.status,
        startedAt: native.startedAt,
        updatedAt: Math.max(native.updatedAt, hook?.updatedAt ?? 0),
        source: hook ? "hook" : "claude-registry",
      });
    }
    for (const hook of liveRuntime) {
      if (out.has(hook.socketPath)) continue;
      out.set(hook.socketPath, {
        sessionId: hook.sessionId,
        cwd: canonical(hook.cwd),
        name: null,
        pid: null,
        socketPath: hook.socketPath,
        messagingToken: hook.messagingToken,
        status: "unknown",
        startedAt: hook.registeredAt,
        updatedAt: hook.updatedAt,
        source: "hook",
      });
    }
    return [...out.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function targetIdentity(target: ClaudeSessionTarget): {
    cwd: string;
    managedName: string | null;
    sessionId: string;
    tmuxName: string;
  } {
    const cwd = canonical(target.cwd);
    const managedName = target.managedName ?? null;
    return {
      cwd,
      managedName,
      sessionId: wtSessionUuid(cwd, managedName),
      tmuxName: claudeTmuxName(target.slug, managedName),
    };
  }

  async function find(target: ClaudeSessionTarget): Promise<ClaudeSessionInfo | null> {
    const identity = targetIdentity(target);
    const all = await list();
    const matches = all.filter(
      (session) =>
        session.sessionId === identity.sessionId && session.cwd === identity.cwd,
    );
    if (matches.length > 1) {
      throw new Error(
        `multiple live Claude processes share session ${identity.sessionId} in ${identity.cwd}`,
      );
    }
    if (matches[0]) return matches[0];

    // Adopt a pre-wt or manually-started primary when cwd makes the
    // association unambiguous. Named sessions require their deterministic
    // UUID because multiple wt sessions may intentionally share a cwd.
    if (identity.managedName !== null) return null;
    const cwdMatches = all.filter(
      (session) =>
        session.cwd === identity.cwd &&
        (session.name === null ||
          session.name === "primary" ||
          session.name === identity.tmuxName),
    );
    if (cwdMatches.length > 1) {
      throw new Error(`multiple live Claude processes are associated with ${identity.cwd}`);
    }
    return cwdMatches[0] ?? null;
  }

  async function waitForRegistration(
    target: ClaudeSessionTarget,
  ): Promise<ClaudeSessionInfo | null> {
    const deadline = deps.now() + START_TIMEOUT_MS;
    while (deps.now() < deadline) {
      const session = await find(target);
      if (session) return session;
      await deps.sleep(START_POLL_MS);
    }
    return null;
  }

  async function assertNativeVersion(): Promise<void> {
    let raw: string;
    try {
      raw = await deps.version();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot check Claude Code version: ${reason}`);
    }
    if (!versionAtLeast(raw)) {
      throw new Error(
        `Claude Code 2.1.228 or newer is required for native session messaging (found ${raw || "unknown"})`,
      );
    }
  }

  async function startUnlocked(target: ClaudeSessionTarget): Promise<ClaudeSessionInfo> {
    await assertNativeVersion();
    const managedName = target.managedName ?? null;
    const started = await deps.startDetached(
      target.slug,
      target.cwd,
      "claude",
      managedName,
    );
    if (!started.ok) throw new Error(started.reason);
    const session = await waitForRegistration(target);
    if (!session) {
      throw new Error(
        `Claude started but did not register a native messaging socket within ${START_TIMEOUT_MS / 1000}s`,
      );
    }
    return session;
  }

  async function start(target: ClaudeSessionTarget): Promise<ClaudeSession> {
    const identity = targetIdentity(target);
    return await withAsyncFileLock(`__claude_session__${identity.tmuxName}`, async () => {
      if (await find(target)) throw new Error(`Claude session ${identity.tmuxName} is already running`);
      return handle(target, await startUnlocked(target));
    });
  }

  async function ensureInfo(
    target: ClaudeSessionTarget,
  ): Promise<{ session: ClaudeSessionInfo; coldStarted: boolean }> {
    const identity = targetIdentity(target);
    return await withAsyncFileLock(`__claude_session__${identity.tmuxName}`, async () => {
      const existing = await find(target);
      if (existing) return { session: existing, coldStarted: false };
      return { session: await startUnlocked(target), coldStarted: true };
    });
  }

  async function ensure(target: ClaudeSessionTarget): Promise<ClaudeSession> {
    const { session } = await ensureInfo(target);
    return handle(target, session);
  }

  async function send(target: ClaudeSessionTarget, text: string): Promise<ClaudeSendResult> {
    if (!text.trim()) return { ok: false, reason: "message is empty" };
    try {
      await assertNativeVersion();
      const { session, coldStarted } = await ensureInfo(target);
      const frames: Record<string, unknown>[] = [];
      if (session.messagingToken) {
        frames.push({ type: "auth", token: session.messagingToken });
      }
      frames.push({
        type: "user",
        message: { role: "user", content: text },
      });
      const sinceMs = deps.now();
      await deps.writeSocket(session.socketPath, frames);

      const deadline = deps.now() + DELIVERY_TIMEOUT_MS;
      while (deps.now() < deadline) {
        if (deps.deliveryLanded(session.cwd, session.sessionId, text, sinceMs)) {
          return { ok: true, coldStarted, delivered: true, resent: false, session };
        }
        await deps.sleep(DELIVERY_POLL_MS);
      }
      return {
        ok: false,
        reason: "Claude accepted the native socket write but the message did not appear in its transcript",
      };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  async function stop(target: ClaudeSessionTarget): Promise<void> {
    const identity = targetIdentity(target);
    await withAsyncFileLock(`__claude_session__${identity.tmuxName}`, async () => {
      await deps.kill(target.slug, "claude", target.managedName ?? null);
      deps.unregisterRuntime({ sessionId: identity.sessionId });
    });
  }

  function handle(target: ClaudeSessionTarget, info: ClaudeSessionInfo): ClaudeSession {
    const identity = targetIdentity(target);
    return {
      ...info,
      send: (text) => send(target, text),
      stop: async () => {
        if (info.sessionId !== identity.sessionId) {
          throw new Error("cannot stop a Claude process that was not started by wt");
        }
        await stop(target);
      },
    };
  }

  return { ensure, find, list, send, start, stop };
}

export const claudeSessions = createClaudeSessions();
