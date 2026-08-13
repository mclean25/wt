/**
 * Addressing, starting and stopping wt-managed Claude Code sessions.
 *
 * Discovery is Claude's own per-process state directory
 * (`~/.claude/sessions/<pid>.json`, see `registry.ts`), which already
 * drops entries whose pid is gone — so "live" needs no second opinion
 * here. Identity is the deterministic conversation UUID wt derives from
 * (cwd, managed name), which is what lets a slug be addressed without
 * anything being persisted.
 *
 * DELIVERY IS NOT HERE. It lives in `harness/session-messaging.ts`,
 * which owns the transport ladder (prompt injection, then terminal
 * input). This module answers "which process is that slug's session,
 * and is it running", and starts one when it isn't.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { withAsyncFileLock } from "../../locks.ts";
import {
  killHarnessSession,
  startHarnessSessionDetached,
} from "../../tmux.ts";
import { wtSessionUuid } from "./jsonl.ts";
import { claudeTmuxName } from "./harness.ts";
import { readRegistry, type RegistryStatus } from "./registry.ts";

const START_TIMEOUT_MS = 20_000;
const START_POLL_MS = 200;

export type ClaudeSessionTarget = {
  slug: string;
  cwd: string;
  managedName?: string | null;
};

export type ClaudeSessionInfo = {
  sessionId: string;
  cwd: string;
  /** The `--name` wt launched with, i.e. the tmux session name. */
  name: string | null;
  pid: number;
  status: RegistryStatus;
  /** Why the session is blocked, when `status === "waiting"`. */
  waitingFor: string | null;
  startedAt: number;
  updatedAt: number;
};

export type ClaudeSession = ClaudeSessionInfo & {
  stop(): Promise<void>;
};

type Dependencies = {
  readNative: typeof readRegistry;
  startDetached(
    slug: string,
    cwd: string,
    harnessId: "claude",
    managedName: string | null,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  kill(slug: string, harnessId: "claude", managedName: string | null): Promise<void>;
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

const defaults: Dependencies = {
  readNative: readRegistry,
  startDetached: startHarnessSessionDetached,
  kill: killHarnessSession,
  now: Date.now,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
};

export function createClaudeSessions(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = { ...defaults, ...overrides };

  function list(): ClaudeSessionInfo[] {
    return deps
      .readNative()
      .map((native) => ({
        sessionId: native.sessionId,
        cwd: canonical(native.cwd),
        name: native.name,
        pid: native.pid,
        status: native.status,
        waitingFor: native.waitingFor,
        startedAt: native.startedAt,
        updatedAt: native.updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
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

  function find(target: ClaudeSessionTarget): ClaudeSessionInfo | null {
    const identity = targetIdentity(target);
    const all = list();
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
      const session = find(target);
      if (session) return session;
      await deps.sleep(START_POLL_MS);
    }
    return null;
  }

  async function startUnlocked(target: ClaudeSessionTarget): Promise<ClaudeSessionInfo> {
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
        `Claude started but did not register within ${START_TIMEOUT_MS / 1000}s`,
      );
    }
    return session;
  }

  async function start(target: ClaudeSessionTarget): Promise<ClaudeSession> {
    const identity = targetIdentity(target);
    return await withAsyncFileLock(`__claude_session__${identity.tmuxName}`, async () => {
      if (find(target)) throw new Error(`Claude session ${identity.tmuxName} is already running`);
      return handle(target, await startUnlocked(target));
    });
  }

  /**
   * The session for `target`, started if it isn't running. Held under
   * the same per-session lock the start path uses, so two concurrent
   * senders can't race two cold starts of one conversation.
   */
  async function ensureInfo(
    target: ClaudeSessionTarget,
  ): Promise<{ session: ClaudeSessionInfo; coldStarted: boolean }> {
    const identity = targetIdentity(target);
    return await withAsyncFileLock(`__claude_session__${identity.tmuxName}`, async () => {
      const existing = find(target);
      if (existing) return { session: existing, coldStarted: false };
      return { session: await startUnlocked(target), coldStarted: true };
    });
  }

  async function ensure(target: ClaudeSessionTarget): Promise<ClaudeSession> {
    const { session } = await ensureInfo(target);
    return handle(target, session);
  }

  async function stop(target: ClaudeSessionTarget): Promise<void> {
    const identity = targetIdentity(target);
    await withAsyncFileLock(`__claude_session__${identity.tmuxName}`, async () => {
      await deps.kill(target.slug, "claude", target.managedName ?? null);
    });
  }

  function handle(target: ClaudeSessionTarget, info: ClaudeSessionInfo): ClaudeSession {
    const identity = targetIdentity(target);
    return {
      ...info,
      stop: async () => {
        if (info.sessionId !== identity.sessionId) {
          throw new Error("cannot stop a Claude process that was not started by wt");
        }
        await stop(target);
      },
    };
  }

  return { ensure, ensureInfo, find, list, start, stop, tmuxNameFor: (t: ClaudeSessionTarget) => targetIdentity(t).tmuxName };
}

export const claudeSessions = createClaudeSessions();
