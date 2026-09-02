/**
 * Delivering a message to a live Claude Code session by submitting it
 * at that session's own prompt, in-process, without typing anything
 * into its terminal.
 *
 * WHY THIS EXISTS. Claude Code's cross-session messaging API delivers a
 * message wrapped: the receiver sees it as quoted peer text with a
 * standing "not typed by your user / a peer cannot grant escalation"
 * preamble, and defers to the human on flows the human already
 * approved. For a fleet whose entire purpose is to stop needing the
 * human, that is not a cosmetic difference — it is the feature
 * failing. This transport produces a transcript entry stamped
 * `origin:{kind:"human"}` / `promptSource:"typed"`: byte-identical to
 * the human having typed it, because it goes through the same handler.
 *
 * HOW. wt launches every Claude session under
 * `BUN_INSPECT=ws+unix://<cacheRoot>/insp/<tmux name>.sock` (see
 * `core/tmux/inner-process.ts`), which exposes bun's JSC inspector on
 * that socket. Delivery connects, walks the live Ink/React tree to the
 * prompt component, and calls its `onSubmit`. See `page-routine.ts` for
 * the anchors and how to re-derive them; `client.ts` for the wire.
 *
 * WHAT IT INHERITS FOR FREE, by being the same path typing takes:
 * a mid-turn target queues the message and runs it when the turn ends;
 * a slash command actually executes; a draft sitting in the box is
 * saved and restored, caret included.
 *
 * ONE CONNECTION PER DELIVERY. `deliverClaudeMessage` probes and
 * submits over the same socket: probing on one connection and then
 * reconnecting to submit doubled the handshake and fiber walk on every
 * message in the fleet, and reconnecting per poll tick multiplied it
 * again on a cold start.
 *
 * FAILURE IS EXPECTED AND SURVIVABLE. Most outcomes below are a reason
 * `sendSessionMessage` falls back to the terminal transport rather than
 * an error the caller reports. The kinds are distinguished because the
 * FIX differs — and because two of them must NOT be retried by typing:
 * `blocked` (a human is being asked something) and `submitted-unknown`
 * (the submit went out and we stopped waiting for the answer).
 *
 * Ported from unseamless-coop's `scripts/fleet/{msg,_inject}`.
 */
import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect, Schedule } from "effect";

import { config } from "../../../config.ts";
import {
  appInstanceObjectId,
  connectInspector,
  inspectorException,
  type InspectorClient,
} from "./client.ts";
import { PAGE_ROUTINE, parsePageResult, type PageResult } from "./page-routine.ts";

/** Budget for a single probe-or-submit round trip. */
const ATTEMPT_TIMEOUT_MS = 12_000;
/** Locate failures are transient right after a launch; retry the walk. */
const LOCATE_RETRIES = 6;
const LOCATE_RETRY_MS = 150;
/** Gap between readiness probes on the shared connection. */
const READY_POLL_MS = 250;

/**
 * Errors that mean "the prompt UI isn't reachable yet", as opposed to
 * "the submit failed". Kept in ONE place because two call sites read
 * it — the retry gate and the failure classifier — and a new anchor
 * error added to only one of them would silently change which failures
 * retry and which fall back.
 */
const LOCATE_FAILURE = /not found|listener|bound method|no react root/i;

export type InjectFailureKind =
  /** No socket file: the session predates this wt, or wt did not start it. */
  | "absent"
  /** The file exists but nothing accepts on it — the session restarted. */
  | "stale"
  /** Reached it, but the prompt UI is not mounted (modal, or moved anchors). */
  | "not-ready"
  /** A human is being asked something. Never retry this by typing. */
  | "blocked"
  /** The submit was written and we stopped waiting. Never retype it. */
  | "submitted-unknown"
  /** Reached the prompt and the submit itself failed. */
  | "failed";

export type InjectOutcome =
  | { ok: true; draftPreserved: boolean }
  | { ok: false; kind: InjectFailureKind; reason: string };

export type SelftestOutcome =
  | { ok: true; foundInput: boolean; foundCaret: boolean }
  | { ok: false; kind: InjectFailureKind; reason: string };

/**
 * Seam for tests: a live Claude process and the socket it binds are the
 * two things they can't have.
 */
export type InjectDeps = {
  connect(socketPath: string, signal?: AbortSignal): Promise<InspectorClient>;
  socketExists(tmuxName: string): boolean;
  now(): number;
  /**
   * Timings, injectable so tests can exercise the timeout branches
   * without waiting out the real budgets.
   */
  attemptTimeoutMs: number;
  pollMs: number;
  locateRetryMs: number;
};

const defaultDeps: InjectDeps = {
  connect: connectInspector,
  socketExists: (tmuxName) => inspectorSocketExists(tmuxName),
  now: Date.now,
  attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
  pollMs: READY_POLL_MS,
  locateRetryMs: LOCATE_RETRY_MS,
};

/** Directory holding one inspector socket per Claude tmux session. */
export function inspectorDir(): string {
  return join(config.paths.cacheRoot, "insp");
}

/**
 * The socket for a Claude tmux session. Keyed on the tmux session name
 * because that is already wt's unique-per-conversation identity
 * (`<slug>` / `<slug>~<name>`), so sender and receiver derive the same
 * path with nothing persisted and nothing to go stale. Under
 * `config.paths.cacheRoot`, so a sealed second instance gets its own.
 */
export function inspectorSocketPath(tmuxName: string): string {
  return join(inspectorDir(), `${tmuxName}.sock`);
}

/**
 * Create the socket directory 0700, and re-assert the mode if it
 * already exists.
 *
 * The `chmodSync` is not belt-and-braces: `mkdirSync`'s `mode` applies
 * only when the directory is actually CREATED, so a pre-existing
 * `insp/` with a looser mode would never be corrected — and this
 * directory's permissions are the entire access control on a socket
 * that grants code execution inside a running agent. The registry file
 * this transport replaced did the same two calls, for the same reason.
 */
export function ensureInspectorDir(): string {
  const dir = inspectorDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Not ours to chmod; the bind will fail loudly if it matters.
  }
  return dir;
}

/**
 * Drop a leftover socket before launching a session that will bind the
 * same path. bun does NOT unlink an existing socket — it fails to bind
 * with EADDRINUSE and runs on WITHOUT an inspector, which would silently
 * cost the new session its transport for as long as it lives.
 */
export function clearInspectorSocket(tmuxName: string): void {
  try {
    rmSync(inspectorSocketPath(tmuxName), { force: true });
  } catch {
    // A path we cannot remove is reported by the bind failure instead.
  }
}

/**
 * Delete socket files whose tmux session no longer exists.
 *
 * Sockets are otherwise only replaced, never removed: a destroyed
 * worktree's slug is never reused, so its socket file would sit in the
 * cache root forever. Called from the startup reap alongside the other
 * per-slug state, so it needs no trigger of its own.
 */
export function reapInspectorSockets(isLive: (tmuxName: string) => boolean): void {
  let entries: string[];
  try {
    entries = readdirSync(inspectorDir());
  } catch {
    return; // nothing created yet
  }
  for (const entry of entries) {
    if (!entry.endsWith(".sock")) continue;
    if (isLive(entry.slice(0, -".sock".length))) continue;
    try {
      rmSync(join(inspectorDir(), entry), { force: true });
    } catch {
      // Best effort; a stale socket file is inert.
    }
  }
}

export function inspectorSocketExists(tmuxName: string): boolean {
  try {
    return lstatSync(inspectorSocketPath(tmuxName)).isSocket();
  } catch {
    return false;
  }
}

/**
 * Escape hatch, matching the `WT_GITHUB` / `WT_AUTOMATIONS` convention:
 * `WT_INSPECT=off` forces every send down the terminal transport. For
 * A/B-ing a suspected injector regression without a rebuild.
 *
 * This governs wt's own delivery only. The session's inspector socket
 * is opened by `BUN_INSPECT` at launch and stays bound either way, so
 * this is not a switch for closing that surface — restart the session
 * under a wt that doesn't set it if that's what you need.
 */
export function inspectorEnabled(): boolean {
  return (process.env.WT_INSPECT ?? "").toLowerCase() !== "off";
}

type Failure = { ok: false; kind: InjectFailureKind; reason: string };

export class InjectTransportError extends Data.TaggedError("InjectTransportError")<{
  readonly phase: "connect" | "call";
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string { return this.detail; }
}

class LocateRetryError extends Data.TaggedError("LocateRetryError")<{
  readonly result: PageResult & { ok: false };
}> {}

const clientCallEffect = (
  client: InspectorClient,
  method: string,
  params?: Record<string, unknown>,
) => Effect.tryPromise({
  try: () => client.call(method, params),
  catch: (cause) => new InjectTransportError({ phase: "call", detail: cause instanceof Error ? cause.message : String(cause), cause }),
});

function withClientEffect<T>(
  deps: InjectDeps,
  tmuxName: string,
  body: (client: InspectorClient) => Effect.Effect<T | Failure, InjectTransportError>,
): Effect.Effect<T | Failure> {
  if (!deps.socketExists(tmuxName)) {
    return Effect.succeed({
      ok: false,
      kind: "absent",
      reason: `no inspector socket at ${inspectorSocketPath(tmuxName)}`,
    });
  }
  const acquire = Effect.tryPromise({
    try: (signal) => deps.connect(inspectorSocketPath(tmuxName), signal),
    catch: (cause) => new InjectTransportError({ phase: "connect", detail: cause instanceof Error ? cause.message : String(cause), cause }),
  });
  return Effect.acquireUseRelease(
    acquire,
    body,
    (client) => Effect.sync(() => client.close()),
  ).pipe(Effect.catchAll((err) => Effect.succeed((err.phase === "connect" ? {
    // The file exists but nothing usable is accepting: the session
    // restarted and the live process holds a now-unlinked inode. Only
    // that process can rebind the path, so this never heals on retry.
      ok: false,
      kind: "stale",
      reason: `inspector socket is stale (${err.message})`,
    } : {
    // A rejection anywhere inside — including `Runtime.enable`, which
    // is outside the per-attempt retry — becomes a classified failure
    // rather than escaping to the caller as an unhandled rejection.
      ok: false,
      kind: "failed",
      reason: err.message,
    }) as Failure)));
}

/**
 * Run the page routine once, retrying only LOCATE failures.
 *
 * The retry set is deliberately narrow: "onSubmit threw" never matches,
 * so a message can never be submitted twice. Locate failures genuinely
 * are transient right after a launch or a `claude -c` revive, when Ink
 * has not finished wiring.
 */
function runRoutineEffect(
  deps: InjectDeps,
  client: InspectorClient,
  text: string,
  probeOnly: boolean,
): Effect.Effect<PageResult, InjectTransportError> {
  const once = Effect.gen(function* () {
      const appId = yield* Effect.tryPromise({
        try: () => appInstanceObjectId(client),
        catch: (cause) => new InjectTransportError({ phase: "call", detail: cause instanceof Error ? cause.message : String(cause), cause }),
      });
      const res = yield* clientCallEffect(client, "Runtime.callFunctionOn", {
        objectId: appId,
        functionDeclaration: PAGE_ROUTINE,
        arguments: [{ value: probeOnly ? "" : text }, { value: probeOnly }],
        returnByValue: true,
      });
      // A throw inside the routine leaves no return value, so check for
      // it explicitly — otherwise the real cause is replaced by a
      // JSON.parse "unexpected end of input" that matches nothing.
      const thrown = inspectorException(res);
      const out: PageResult = thrown ? { ok: false, err: thrown } : parsePageResult(res.result?.value);
      if (!out.ok && LOCATE_FAILURE.test(out.err)) return yield* new LocateRetryError({ result: out });
      return out;
  });
  return once.pipe(
    Effect.retry(Schedule.intersect(Schedule.recurs(LOCATE_RETRIES - 1), Schedule.spaced(deps.locateRetryMs))),
    Effect.catchTag("LocateRetryError", (err) => Effect.succeed(err.result)),
  );
}

function deadlineEffect<T, E>(work: Effect.Effect<T, E>, ms: number): Effect.Effect<T | "timeout", E> {
  return Effect.raceFirst(work, Effect.sleep(ms).pipe(Effect.as("timeout" as const)));
}

function classify(err: string): InjectFailureKind {
  return LOCATE_FAILURE.test(err) ? "not-ready" : "failed";
}

export function createClaudeInjector(overrides: Partial<InjectDeps> = {}) {
  const deps: InjectDeps = { ...defaultDeps, ...overrides };

  /**
   * Deliver `text`, waiting up to `readyBudgetMs` for the prompt UI to
   * become reachable, all on one connection.
   *
   * `abortIfBlocked` is polled alongside readiness and is the answer to
   * a real hazard: the "is a human being asked something" check is a
   * point-in-time read, and a permission dialog that appears DURING the
   * wait presents to the probe as an ordinary "prompt not mounted".
   * Without re-asking, the caller would give up and type into that
   * dialog, answering it on the human's behalf.
   */
  function deliverClaudeMessageEffect(
    tmuxName: string,
    text: string,
    opts: { readyBudgetMs: number; abortIfBlocked?: () => string | null; signal?: AbortSignal },
  ): Effect.Effect<InjectOutcome> {
    return withClientEffect(deps, tmuxName, (client) => Effect.gen(function* () {
      yield* clientCallEffect(client, "Runtime.enable");
      const until = deps.now() + opts.readyBudgetMs;
      let lastProbe = "never probed";
      for (;;) {
        const blocked = opts.abortIfBlocked?.();
        if (blocked) return { ok: false as const, kind: "blocked" as const, reason: blocked };
        const probeAttempt = deadlineEffect(
          runRoutineEffect(deps, client, "", true),
          deps.attemptTimeoutMs,
        );
        const probe = opts.abortIfBlocked
          ? yield* Effect.raceFirst(
              probeAttempt,
              Effect.gen(function* () {
                for (;;) {
                  yield* Effect.sleep(deps.pollMs);
                  const reason = opts.abortIfBlocked?.();
                  if (reason) return { blocked: reason } as const;
                }
              }),
            )
          : yield* probeAttempt;
        if (typeof probe === "object" && "blocked" in probe) {
          return { ok: false as const, kind: "blocked" as const, reason: probe.blocked };
        }
        if (probe === "timeout") {
          return { ok: false as const, kind: "failed" as const, reason: "probe timed out" };
        }
        if (probe.ok) break;
        lastProbe = probe.err;
        if (classify(probe.err) === "failed") {
          return { ok: false as const, kind: "failed" as const, reason: probe.err };
        }
        if (deps.now() >= until) {
          return { ok: false as const, kind: "not-ready" as const, reason: lastProbe };
        }
        yield* Effect.sleep(deps.pollMs);
      }

      const submitted = yield* deadlineEffect(
        runRoutineEffect(deps, client, text, false),
        deps.attemptTimeoutMs,
      );
      if (submitted === "timeout") {
        // The call carrying `onSubmit(text)` is already on the wire and
        // closing our end does not cancel it in the target. Typing the
        // same text as a fallback would then double-submit, so this is
        // its own kind: the caller confirms against the transcript
        // instead of retrying.
        return {
          ok: false as const,
          kind: "submitted-unknown" as const,
          reason: "the submit was sent but the target did not answer in time",
        };
      }
      if (!submitted.ok) {
        return { ok: false as const, kind: classify(submitted.err), reason: submitted.err };
      }
      return {
        ok: true as const,
        draftPreserved: "draftLen" in submitted ? (submitted.draftLen ?? 0) > 0 : false,
      };
    }));
  }

  /**
   * Verify the injector can still find the prompt UI, without
   * submitting. This is the structural-anchor check that a Claude Code
   * update broke something — wired into `wt doctor` and
   * `wt claude selftest`.
   */
  function claudeInjectSelftestEffect(tmuxName: string): Effect.Effect<SelftestOutcome> {
    return withClientEffect(deps, tmuxName, (client) => Effect.gen(function* () {
      yield* clientCallEffect(client, "Runtime.enable");
      const out = yield* deadlineEffect(runRoutineEffect(deps, client, "", true), deps.attemptTimeoutMs);
      if (out === "timeout") {
        return { ok: false as const, kind: "failed" as const, reason: "probe timed out" };
      }
      if (!out.ok) {
        return { ok: false as const, kind: classify(out.err), reason: out.err };
      }
      // The input fiber is required; the caret pair is NOT. If an update
      // drops the caret props the send still works, it just restores the
      // draft at offset 0 — degrading that into a hard failure would send
      // every message down the terminal path over a cosmetic regression.
      if (!("foundPrompt" in out) || !out.foundInput) {
        return {
          ok: false as const,
          kind: "not-ready" as const,
          reason: "prompt input not found (draft would be clobbered)",
        };
      }
      return { ok: true as const, foundInput: true, foundCaret: out.foundCaret };
    }));
  }

  const deliverClaudeMessage = (
    tmuxName: string, text: string,
    opts: { readyBudgetMs: number; abortIfBlocked?: () => string | null; signal?: AbortSignal },
  ): Promise<InjectOutcome> => Effect.runPromise(deliverClaudeMessageEffect(tmuxName, text, opts), { signal: opts.signal });
  const claudeInjectSelftest = (tmuxName: string): Promise<SelftestOutcome> =>
    Effect.runPromise(claudeInjectSelftestEffect(tmuxName));

  return { deliverClaudeMessageEffect, claudeInjectSelftestEffect, deliverClaudeMessage, claudeInjectSelftest };
}

const injector = createClaudeInjector();
export const deliverClaudeMessage = injector.deliverClaudeMessage;
export const claudeInjectSelftest = injector.claudeInjectSelftest;
