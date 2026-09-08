import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  CodexTerminalReadinessTimeout,
  probeCodexTerminalReadiness,
  waitForCodexTerminalReady,
} from "./readiness.ts";
import { discoverCodexSessionsSync } from "./harness.ts";
import { CODEX_MAIN_PROMPT, CODEX_MANAGER_PROMPT } from "./slot.ts";

const CWD = "/tmp/example-worktree";

function lifecycle(type: string): string {
  return JSON.stringify({
    timestamp: "2026-09-08T12:00:00.000Z",
    type: "event_msg",
    payload: { type, turn_id: "turn-1" },
  });
}

function createRollout(
  root: string,
  id: string,
  events: readonly string[],
  partition = "2026/09/08",
): string {
  const dir = join(root, partition);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-${id}.jsonl`);
  const meta = JSON.stringify({
    type: "session_meta",
    payload: {
      id,
      cwd: CWD,
      originator: "codex-tui",
      thread_source: "user",
    },
  });
  writeFileSync(path, `${[meta, ...events].join("\n")}\n`);
  return path;
}

function opts(root: string, sessionId = "thread-a") {
  return { cwd: CWD, slug: "feature", sessionId, sessionsDir: root };
}

describe("Codex terminal fallback readiness", () => {
  test("permits only a positively closed turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-codex-ready-"));
    createRollout(root, "thread-a", [lifecycle("task_started"), lifecycle("task_complete")]);

    const result = await Effect.runPromise(probeCodexTerminalReadiness(opts(root)));
    expect(result.ready).toBeTrue();
  });

  test("blocks a working turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-codex-working-"));
    createRollout(root, "thread-a", [lifecycle("task_started")]);

    expect(await Effect.runPromise(probeCodexTerminalReadiness(opts(root)))).toMatchObject({
      ready: false,
      reason: "working",
    });
  });

  test("models question and approval requests within an active turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-codex-interaction-"));
    createRollout(root, "question", [
      lifecycle("task_started"),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call", name: "request_user_input" },
      }),
    ]);
    createRollout(root, "approval", [
      lifecycle("task_started"),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "exec_approval_request" },
      }),
    ]);

    expect(await Effect.runPromise(probeCodexTerminalReadiness(opts(root, "question")))).toMatchObject({
      ready: false,
      reason: "question",
    });
    expect(await Effect.runPromise(probeCodexTerminalReadiness(opts(root, "approval")))).toMatchObject({
      ready: false,
      reason: "approval",
    });
  });

  test("surfaces rollout questions while the native daemon is unavailable", () => {
    const root = mkdtempSync(join(tmpdir(), "wt-codex-question-state-"));
    createRollout(root, "question-state", [
      lifecycle("task_started"),
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call", name: "request_user_input" },
      }),
    ]);

    const [session] = discoverCodexSessionsSync("feature", CWD, root);
    expect(session?.extras).toMatchObject({
      derivedState: "asking",
      waitingFor: "question prompt",
    });
  });

  test("treats missing or malformed lifecycle state as unknown", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-codex-unknown-"));
    createRollout(root, "thread-a", ["{malformed", JSON.stringify({ type: "response_item" })]);

    expect(await Effect.runPromise(probeCodexTerminalReadiness(opts(root)))).toMatchObject({
      ready: false,
      reason: "unknown",
    });
    expect(await Effect.runPromise(probeCodexTerminalReadiness(opts(root, "absent")))).toEqual({
      ready: false,
      reason: "rollout-not-found",
      rollout: null,
    });
  });

  test("resolves the exact UUID even when another rollout is newer", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-codex-exact-"));
    createRollout(root, "thread-a", [lifecycle("task_started"), lifecycle("task_complete")], "2026/01/01");
    createRollout(root, "thread-b", [lifecycle("task_started")], "2026/09/08");

    expect(await Effect.runPromise(probeCodexTerminalReadiness(opts(root, "thread-a")))).toMatchObject({
      ready: true,
    });
    expect(await Effect.runPromise(probeCodexTerminalReadiness(opts(root, "thread-b")))).toMatchObject({
      ready: false,
      reason: "working",
    });
  });

  test("keeps main and manager ownership filtering", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-codex-slot-ready-"));
    const opening = (text: string) => JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    createRollout(root, "main-thread", [
      opening(CODEX_MAIN_PROMPT),
      lifecycle("task_started"),
      lifecycle("task_complete"),
    ]);
    createRollout(root, "manager-thread", [
      opening(CODEX_MANAGER_PROMPT),
      lifecycle("task_started"),
      lifecycle("task_complete"),
    ]);

    expect(await Effect.runPromise(probeCodexTerminalReadiness({
      ...opts(root, "main-thread"),
      slug: "main",
    }))).toMatchObject({ ready: true });
    expect(await Effect.runPromise(probeCodexTerminalReadiness({
      ...opts(root, "manager-thread"),
      slug: "main",
    }))).toMatchObject({ ready: false, reason: "rollout-not-found" });
    expect(await Effect.runPromise(probeCodexTerminalReadiness({
      ...opts(root, "manager-thread"),
      slug: "manager",
    }))).toMatchObject({ ready: true });
  });

  test("returns a typed timeout with the last unsafe state", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-codex-timeout-"));
    createRollout(root, "thread-a", [lifecycle("task_started")]);

    const error = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(waitForCodexTerminalReady({
        ...opts(root),
        timeoutMs: 200,
        pollIntervalMs: 100,
      }).pipe(Effect.flip));
      yield* TestClock.adjust(200);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())));

    expect(error).toBeInstanceOf(CodexTerminalReadinessTimeout);
    expect(error.lastProbe).toMatchObject({ ready: false, reason: "working" });
  });

  test("polling is interruptible while waiting", async () => {
    const root = mkdtempSync(join(tmpdir(), "wt-codex-interrupt-"));
    const path = createRollout(root, "thread-a", [lifecycle("task_started")]);

    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(waitForCodexTerminalReady({
        ...opts(root),
        timeoutMs: 1_000,
        pollIntervalMs: 100,
      }));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBeTrue();

      // Becoming ready after cancellation cannot revive the stopped waiter.
      writeFileSync(path, `${lifecycle("task_complete")}\n`, { flag: "a" });
      statSync(path);
      yield* TestClock.adjust(1_000);
    }).pipe(Effect.provide(TestClock.layer())));
  });
});
