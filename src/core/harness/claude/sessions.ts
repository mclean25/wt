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
import { Data, Effect } from "effect";

import { withAsyncFileLock } from "../../locks.ts";
import { killHarnessSession } from "../../tmux/admin.ts";
import { startHarnessSessionDetached } from "../../tmux/lifecycle.ts";
import { capturePane } from "../../tmux/process.ts";
import { wtSessionUuid } from "./jsonl.ts";
import { claudeTmuxName } from "./harness.ts";
import { readRegistry, type RegistryStatus } from "./registry.ts";

const START_TIMEOUT_MS = 20_000;
const START_POLL_MS = 200;
/** Pane lines quoted back when a start fails — enough for a prompt or a stack head. */
const PANE_TAIL_LINES = 8;

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

export class ClaudeSessionError extends Data.TaggedError("ClaudeSessionError")<{
  readonly operation: "find" | "start" | "stop" | "pane" | "wait";
  readonly message: string;
  readonly cause?: unknown;
}> {}

type Dependencies = {
  readNative: typeof readRegistry;
  startDetached(
    slug: string,
    cwd: string,
    harnessId: "claude",
    managedName: string | null,
  ): Promise<{ ok: true; adopted?: boolean } | { ok: false; reason: string }>;
  kill(slug: string, harnessId: "claude", managedName: string | null): Promise<void>;
  /**
   * The tmux pane's visible text, or null when it can't be read. Only
   * consulted on the failure path: when a start doesn't register, the
   * pane is the ONLY place saying why, and nothing else surfaces it —
   * the `.err` file catches the wrapper's stderr and is empty in every
   * observed instance, and `wt logs <slug>` answers about destroy logs.
   */
  peekPane(tmuxName: string): Promise<string | null>;
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

const defaults: Pick<Dependencies, "readNative" | "now"> = {
  readNative: readRegistry,
  now: Date.now,
};

export function createClaudeSessions(overrides: Partial<Dependencies> = {}) {
  const deps = { ...defaults, ...overrides };

  const fail = (
    operation: ClaudeSessionError["operation"],
    cause: unknown,
  ): ClaudeSessionError => new ClaudeSessionError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

  const startDetachedEffect = (
    target: ClaudeSessionTarget,
    managedName: string | null,
  ) => overrides.startDetached
    ? Effect.tryPromise({
        try: () => overrides.startDetached!(target.slug, target.cwd, "claude", managedName),
        catch: (cause) => fail("start", cause),
      })
    : startHarnessSessionDetached(
        target.slug,
        target.cwd,
        "claude",
        managedName,
      ).pipe(Effect.mapError((cause) => fail("start", cause)));

  const killEffect = (target: ClaudeSessionTarget, managedName: string | null) =>
    overrides.kill
      ? Effect.tryPromise({
          try: () => overrides.kill!(target.slug, "claude", managedName),
          catch: (cause) => fail("stop", cause),
        })
      : killHarnessSession(target.slug, "claude", managedName).pipe(
          Effect.mapError((cause) => fail("stop", cause)),
        );

  const peekPaneEffect = (tmuxName: string) => overrides.peekPane
    ? Effect.tryPromise({
        try: () => overrides.peekPane!(tmuxName),
        catch: (cause) => fail("pane", cause),
      })
    : capturePane(tmuxName).pipe(
        Effect.mapError((cause) => fail("pane", cause)),
      );

  const sleepEffect = (ms: number) => overrides.sleep
    ? Effect.tryPromise({
        try: () => overrides.sleep!(ms),
        catch: (cause) => fail("wait", cause),
      })
    : Effect.sleep(ms);

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

  function waitForRegistrationEffect(
    target: ClaudeSessionTarget,
  ): Effect.Effect<ClaudeSessionInfo | null, ClaudeSessionError> {
    return Effect.gen(function* () {
      const deadline = deps.now() + START_TIMEOUT_MS;
      while (deps.now() < deadline) {
        const session = yield* Effect.try({
          try: () => find(target),
          catch: (cause) => fail("find", cause),
        });
        if (session) return session;
        yield* sleepEffect(START_POLL_MS);
      }
      return null;
    });
  }

  /**
   * Last few non-blank lines of the session's pane, for a failure
   * message. The pane is where a harness that refused to start says so
   * (a trust prompt, a crash, an auth expiry), and it is otherwise
   * unreachable to whoever ran the command: the wrapper's `.err` file
   * is empty in every observed instance, and `wt logs <slug>` is about
   * destroy logs. An explicitly EMPTY pane is worth saying too — it is
   * the difference between "it printed a reason" and "nothing ever
   * ran", which is the first fork in diagnosing this.
   */
  function paneTailEffect(tmuxName: string): Effect.Effect<string, ClaudeSessionError> {
    return peekPaneEffect(tmuxName).pipe(Effect.map((text) => {
      if (text === null) return "  (pane could not be read)";
      const lines = text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.trim() !== "");
      if (lines.length === 0) return "  (pane is empty — nothing has run in it)";
      return lines
        .slice(-PANE_TAIL_LINES)
        .map((line) => `  | ${line}`)
        .join("\n");
    }));
  }

  function startUnlockedEffect(
    target: ClaudeSessionTarget,
  ): Effect.Effect<ClaudeSessionInfo, ClaudeSessionError> {
    return Effect.gen(function* () {
      const managedName = target.managedName ?? null;
      const identity = targetIdentity(target);
      const started = yield* startDetachedEffect(target, managedName);
      if (!started.ok) {
        return yield* new ClaudeSessionError({
          operation: "start",
          message: started.reason,
        });
      }
      const session = yield* waitForRegistrationEffect(target);
      if (session) return session;

    // Nothing registered. If the tmux session ALREADY EXISTED, this
    // call created nothing and waited out the timeout on somebody
    // else's broken session — which is also exactly what the retry
    // would do, forever. tmux refuses a duplicate name, so every
    // attempt re-adopts the same corpse: two attempts 42 seconds apart
    // are in the log, both reporting a 20s "did not register".
    //
    // Recycling is safe HERE and nowhere earlier. We hold the
    // per-session lock, no claude is registered for this identity, and
    // a full registration timeout has elapsed — so the genuine race
    // this adoption path exists for (a concurrent creator whose claude
    // is a moment from registering) has already had its whole window
    // and lost. A session in that state has no conversation to lose.
      if (started.adopted) {
        const before = yield* paneTailEffect(identity.tmuxName);
        yield* killEffect(target, managedName);
        const restarted = yield* startDetachedEffect(target, managedName);
        if (!restarted.ok) {
          return yield* new ClaudeSessionError({
            operation: "start",
            message: restarted.reason,
          });
        }
        const recovered = yield* waitForRegistrationEffect(target);
        if (recovered) return recovered;
        const after = yield* paneTailEffect(identity.tmuxName);
        return yield* new ClaudeSessionError({
          operation: "start",
          message:
            `Claude did not register within ${START_TIMEOUT_MS / 1000}s, and did not ` +
            `after recycling the pre-existing ${identity.tmuxName} session either. ` +
            `The stuck pane held:\n${before}\nNow:\n${after}`,
        });
      }

      const pane = yield* paneTailEffect(identity.tmuxName);
      return yield* new ClaudeSessionError({
        operation: "start",
        message:
          `Claude started but did not register within ${START_TIMEOUT_MS / 1000}s. ` +
          `Its pane (${identity.tmuxName}) holds:\n${pane}`,
      });
    });
  }

  function startEffect(target: ClaudeSessionTarget) {
    const identity = targetIdentity(target);
    return withAsyncFileLock(
      `__claude_session__${identity.tmuxName}`,
      Effect.gen(function* () {
        const existing = yield* Effect.try({
          try: () => find(target),
          catch: (cause) => fail("find", cause),
        });
        if (existing) {
          return yield* new ClaudeSessionError({
            operation: "start",
            message: `Claude session ${identity.tmuxName} is already running`,
          });
        }
        return handle(target, yield* startUnlockedEffect(target));
      }),
    );
  }

  /**
   * The session for `target`, started if it isn't running. Held under
   * the same per-session lock the start path uses, so two concurrent
   * senders can't race two cold starts of one conversation.
   */
  function ensureInfoEffect(
    target: ClaudeSessionTarget,
  ) {
    const identity = targetIdentity(target);
    return withAsyncFileLock(
      `__claude_session__${identity.tmuxName}`,
      Effect.gen(function* () {
        const existing = yield* Effect.try({
          try: () => find(target),
          catch: (cause) => fail("find", cause),
        });
        if (existing) return { session: existing, coldStarted: false };
        return { session: yield* startUnlockedEffect(target), coldStarted: true };
      }),
    );
  }

  const ensureEffect = (target: ClaudeSessionTarget) => ensureInfoEffect(target).pipe(
    Effect.map(({ session }) => handle(target, session)),
  );

  function stopEffect(target: ClaudeSessionTarget) {
    const identity = targetIdentity(target);
    return withAsyncFileLock(
      `__claude_session__${identity.tmuxName}`,
      killEffect(target, target.managedName ?? null),
    );
  }

  const start = (target: ClaudeSessionTarget): Promise<ClaudeSession> =>
    Effect.runPromise(startEffect(target));
  const ensureInfo = (target: ClaudeSessionTarget) =>
    Effect.runPromise(ensureInfoEffect(target));
  const ensure = (target: ClaudeSessionTarget): Promise<ClaudeSession> =>
    Effect.runPromise(ensureEffect(target));
  const stop = (target: ClaudeSessionTarget): Promise<void> =>
    Effect.runPromise(stopEffect(target));

  function handle(target: ClaudeSessionTarget, info: ClaudeSessionInfo): ClaudeSession {
    const identity = targetIdentity(target);
    return {
      ...info,
      stop: () => {
        if (info.sessionId !== identity.sessionId) {
          return Effect.runPromise(Effect.fail(new ClaudeSessionError({
            operation: "stop",
            message: "cannot stop a Claude process that was not started by wt",
          })));
        }
        return stop(target);
      },
    };
  }

  return {
    ensure,
    ensureEffect,
    ensureInfo,
    ensureInfoEffect,
    find,
    list,
    start,
    startEffect,
    stop,
    stopEffect,
    tmuxNameFor: (target: ClaudeSessionTarget) => targetIdentity(target).tmuxName,
  };
}

export const claudeSessions = createClaudeSessions();
