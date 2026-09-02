import { join } from "node:path";
import { Data, Effect, Result } from "effect";

import {
  getHarness,
  primarySingleSlotSession,
  type HarnessId,
} from "../harness/index.ts";
import { createLogger } from "../logger.ts";
import { buildInnerArgs, ensureHarnessTrusted, sessionsDir, tmuxClientCwd } from "./attach.ts";
import { ensureConfig } from "./config.ts";
import { prepareInspectorSocket, wrapInnerArgs } from "./inner-process.ts";
import { sessionName, TMUX_SOCKET } from "./naming.ts";
import { listAllSessionsRaw } from "./process.ts";

const log = createLogger("[tmux]");

/**
 * `adopted` means the session already existed and this call created
 * nothing. The caller needs that distinction because the two cases
 * diverge completely a few seconds later: a session we just created
 * that fails to register is a broken harness start, while an ADOPTED
 * one that fails to register was already broken before we arrived, and
 * no amount of waiting or retrying will move it — only tearing it down
 * will. Collapsing them into a bare `ok` is what made a failed start
 * sticky: every retry re-adopted the same dead session, waited the
 * full registration timeout, and reported a timing error.
 */
export type StartHarnessSessionResult =
  | { ok: true; adopted?: boolean }
  | { ok: false; reason: string };

class HarnessStartError extends Data.TaggedError("HarnessStartError")<{
  readonly operation: "discover" | "spawn" | "wait";
  readonly cause: unknown;
}> {}

/**
 * Create a worktree harness session detached, without attaching a tmux
 * client. This is the same session `attachOrCreate` would make: it uses
 * the shared name, harness argv, stderr wrapper, and tmux environment.
 *
 * A concurrent attached or detached creator may win the `new-session`
 * race. In that case the desired session already exists, so treat the
 * start as successful rather than surfacing tmux's duplicate-session
 * error.
 */
export const startHarnessSessionDetached = Effect.fn("startHarnessSessionDetached")(function* (
  slug: string,
  cwd: string,
  harnessId: HarnessId,
  managedName: string | null = null,
): Effect.fn.Return<StartHarnessSessionResult> {
  const harness = getHarness(harnessId);
  const name = sessionName(slug, harnessId, managedName);
  // ensureConfig, NOT writeConfig: this can run from inside the wt tmux
  // server. Rewriting config there could kill every live session.
  const configPath = ensureConfig();
  const stderrPath = join(sessionsDir(), `${name}.err`);
  let resumeSessionId: string | null = null;
  if (harness.singleSlot) {
    const discovered = yield* Effect.result(Effect.tryPromise({
      try: () => harness.discoverSessions({ slug, wtPath: cwd }),
      catch: (cause) => new HarnessStartError({ operation: "discover", cause }),
    }));
    if (Result.isFailure(discovered)) {
      const cause = discovered.failure.cause;
      const reason = cause instanceof Error ? cause.message : String(cause);
      log.error("detached harness resume discovery failed", {
        slug,
        harnessId,
        reason,
      });
      return {
        ok: false,
        reason: `could not resolve ${harness.label} primary session: ${reason}`,
      };
    }
    const sessions = discovered.success;
    resumeSessionId = primarySingleSlotSession(sessions)?.sessionId ?? null;
  }
  yield* ensureHarnessTrusted(harness, cwd);
  const innerArgs = buildInnerArgs({
    slug,
    cwd,
    kind: harnessId,
    harness,
    managedNameNorm: managedName,
    resumeSessionId,
  });
  // Before the spawn, so a leftover socket from a dead session of the
  // same name can't cost this one its inspector (see the helper).
  yield* prepareInspectorSocket(harnessId, name);
  const outcome = yield* Effect.result(Effect.acquireUseRelease(
    Effect.try({
      try: () => Bun.spawn(
      [
        "tmux",
        "-L",
        TMUX_SOCKET,
        "-f",
        configPath,
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        cwd,
        "-x",
        "200",
        "-y",
        "50",
        ...wrapInnerArgs({
          kind: harnessId,
          stderrPath,
          innerArgs,
          slug,
          tmuxName: name,
        }),
      ],
      {
        // The pane cwd comes from `-c`; pin the server's birth cwd to
        // the stable client cwd (see tmuxClientCwd).
        cwd: tmuxClientCwd(),
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          TERM: process.env.TERM ?? "xterm-256color",
          COLORTERM: process.env.COLORTERM ?? "truecolor",
          FORCE_COLOR: process.env.FORCE_COLOR ?? "3",
        },
      },
      ),
      catch: (cause) => new HarnessStartError({ operation: "spawn", cause }),
    }),
    (proc) => Effect.tryPromise({
      try: async () => {
        const [code, stderr] = await Promise.all([
          proc.exited,
          new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
        ]);
        return { code, stderr };
      },
      catch: (cause) => new HarnessStartError({ operation: "wait", cause }),
    }),
    (proc) => Effect.promise(async () => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
      await proc.exited.catch(() => -1);
    }),
  ));
  if (Result.isFailure(outcome)) {
    const cause = outcome.failure.cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    log.error("detached harness start spawn failed", { slug, harnessId, reason });
    return { ok: false, reason };
  }
  const { code, stderr } = outcome.success;
  if (code !== 0) {
    const nowExists = (yield* listAllSessionsRaw()).has(name);
    if (nowExists) {
      log.warn("detached harness start adopted an existing session", {
        slug,
        harnessId,
        code,
      });
      return { ok: true, adopted: true };
    }
    const reason = stderr.trim() || `tmux new-session exited ${code}`;
    log.warn("detached harness start failed", { slug, harnessId, code, reason });
    return { ok: false, reason };
  }
  return { ok: true };
});
