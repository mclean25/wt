/**
 * The failure taxonomy, which is the part the ladder above branches on.
 *
 * Two of these kinds mean "do NOT retry this by typing" — `blocked`
 * (a human is being asked something) and `submitted-unknown` (the
 * submit went out and we stopped waiting). Getting either of them
 * wrong is how wt would answer somebody's permission dialog, or send
 * the same message twice.
 */
import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber } from "effect";

import type { InspectorClient } from "./client.ts";
import { createClaudeInjector } from "./transport.ts";

type StubOpts = {
  /** JSON the page routine "returns", per call, in order. */
  results?: unknown[];
  /** Throw from `Runtime.enable`. */
  enableThrows?: boolean;
  /** Report a target-side exception instead of a value. */
  exception?: string;
  /** Never answer — exercises the attempt timeout. */
  hang?: boolean;
  /** Answer the first N page-routine calls, then hang. */
  hangAfterRoutines?: number;
};

function injector(opts: StubOpts & { connectFails?: boolean; noSocket?: boolean } = {}) {
  const results = [...(opts.results ?? [])];
  let calls = 0;
  let closes = 0;
  let routines = 0;
  const client: InspectorClient = {
    async call(method) {
      calls += 1;
      if (method === "Runtime.enable") {
        if (opts.enableThrows) throw new Error("enable exploded");
        return {};
      }
      if (opts.hang) return await new Promise(() => {});
      if (method === "Runtime.evaluate") return { result: { objectId: "app" } };
      if (method === "Runtime.getProperties") {
        return { internalProperties: [{ name: "boundThis", value: { objectId: "ink" } }] };
      }
      if (opts.exception) {
        return { exceptionDetails: { exception: { description: opts.exception } } };
      }
      routines += 1;
      if (opts.hangAfterRoutines !== undefined && routines > opts.hangAfterRoutines) {
        return await new Promise(() => {});
      }
      const next = results.shift() ?? { ok: true, submitted: true, draftLen: 0, cursor: null };
      return { result: { value: JSON.stringify(next) } };
    },
    close() { closes += 1; },
  };
  return {
    calls: () => calls,
    closes: () => closes,
    injector: createClaudeInjector({
      socketExists: () => !opts.noSocket,
      connect: async () => {
        if (opts.connectFails) throw new Error("connection refused");
        return client;
      },
      now: Date.now,
      attemptTimeoutMs: 250,
      pollMs: 1,
      locateRetryMs: 1,
    }),
  };
}

const READY = { ok: true, foundPrompt: true, foundInput: true, foundCaret: true };
const NOT_MOUNTED = { ok: false, err: "prompt fiber not found" };

describe("failure classification", () => {
  test("a missing socket is `absent` — the session predates this wt", async () => {
    const { injector: inj } = injector({ noSocket: true });
    const out = await inj.deliverClaudeMessagePromise("eng-1", "hi", { readyBudgetMs: 50 });
    expect(out).toMatchObject({ ok: false, kind: "absent" });
  });

  test("a socket nothing answers on is `stale` — the session restarted", async () => {
    // Distinct from absent because the remedy differs: only the live
    // process can rebind that path, so this never heals on retry.
    const { injector: inj } = injector({ connectFails: true });
    const out = await inj.deliverClaudeMessagePromise("eng-1", "hi", { readyBudgetMs: 50 });
    expect(out).toMatchObject({ ok: false, kind: "stale" });
  });

  test("a prompt that never mounts is `not-ready` after the budget", async () => {
    const { injector: inj } = injector({ results: Array(200).fill(NOT_MOUNTED) });
    const out = await inj.deliverClaudeMessagePromise("eng-1", "hi", { readyBudgetMs: 50 });
    expect(out).toMatchObject({ ok: false, kind: "not-ready" });
  });

  test("a prompt that mounts late is waited for, then submitted into", async () => {
    const { injector: inj } = injector({
      results: [NOT_MOUNTED, NOT_MOUNTED, READY, { ok: true, submitted: true, draftLen: 4 }],
    });
    const out = await inj.deliverClaudeMessagePromise("eng-1", "hi", { readyBudgetMs: 200 });
    expect(out).toMatchObject({ ok: true, draftPreserved: true });
  });

  test("a human-blocking dialog aborts the wait before any submit", async () => {
    // The abort is polled THROUGHOUT the readiness wait, because a
    // dialog that appears mid-wait looks exactly like a prompt that
    // hasn't mounted yet.
    let ticks = 0;
    const { injector: inj } = injector({ results: Array(200).fill(NOT_MOUNTED) });
    const out = await inj.deliverClaudeMessagePromise("eng-1", "hi", {
      readyBudgetMs: 200,
      abortIfBlocked: () => (++ticks > 2 ? "waiting on a permission prompt" : null),
    });
    expect(out).toMatchObject({ ok: false, kind: "blocked" });
  });

  test("a hang after the probe reports `submitted-unknown`, never a plain failure", async () => {
    // The probe answers, then the submit never does. That call carrying
    // onSubmit is already on the wire and closing our socket doesn't
    // cancel it in the target — so the caller must confirm against the
    // transcript rather than fall back and type the same text again.
    const stub = injector({ results: [READY], hangAfterRoutines: 1 });
    const { injector: inj } = stub;
    const out = await inj.deliverClaudeMessagePromise("eng-1", "hi", { readyBudgetMs: 50 });
    expect(out).toMatchObject({ ok: false, kind: "submitted-unknown" });
    expect(stub.closes()).toBe(1);
  });

  test("a hang on the PROBE is an ordinary failure — nothing was submitted", async () => {
    const { injector: inj } = injector({ hangAfterRoutines: 0 });
    const out = await inj.deliverClaudeMessagePromise("eng-1", "hi", { readyBudgetMs: 50 });
    expect(out).toMatchObject({ ok: false, kind: "failed" });
  });

  test("a target-side exception is surfaced, not replaced by a parse error", async () => {
    // Without reading exceptionDetails, a throw in the fiber walk came
    // back as "Unexpected end of JSON input" — hiding the cause and
    // matching none of the classification patterns.
    const { injector: inj } = injector({ exception: "TypeError: f.child is undefined" });
    const out = await inj.claudeInjectSelftestPromise("eng-1");
    expect(out).toMatchObject({ ok: false });
    expect(out.ok === false && out.reason).toContain("f.child is undefined");
  });

  test("a throwing Runtime.enable is classified, not thrown at the caller", async () => {
    // It sits outside the per-attempt retry, so an unhandled rejection
    // here would escape the whole ladder.
    const { injector: inj } = injector({ enableThrows: true });
    const out = await inj.deliverClaudeMessagePromise("eng-1", "hi", { readyBudgetMs: 50 });
    expect(out).toMatchObject({ ok: false, kind: "failed" });
  });

  test("an unrecognized page-routine shape is a failure, not an undefined reason", async () => {
    // The routine crosses a process boundary into code that tracks
    // upstream Claude Code, so its shape is an assumption. An unchecked
    // cast put `undefined` into a user-facing warning.
    const { injector: inj } = injector({ results: [{ ok: true, mystery: 1 }] });
    const out = await inj.claudeInjectSelftestPromise("eng-1");
    expect(out).toMatchObject({ ok: false });
    expect(out.ok === false && typeof out.reason).toBe("string");
  });
});

describe("selftest", () => {
  test("a mounted prompt with caret support passes", async () => {
    const { injector: inj } = injector({ results: [READY] });
    expect(await inj.claudeInjectSelftestPromise("eng-1")).toMatchObject({
      ok: true,
      foundInput: true,
      foundCaret: true,
    });
  });

  test("a missing caret degrades but still passes — the draft just lands at 0", async () => {
    const { injector: inj } = injector({
      results: [{ ok: true, foundPrompt: true, foundInput: true, foundCaret: false }],
    });
    expect(await inj.claudeInjectSelftestPromise("eng-1")).toMatchObject({
      ok: true,
      foundCaret: false,
    });
  });

  test("a missing input fails — submitting would clobber the draft", async () => {
    const { injector: inj } = injector({
      results: [{ ok: true, foundPrompt: true, foundInput: false, foundCaret: false }],
    });
    expect(await inj.claudeInjectSelftestPromise("eng-1")).toMatchObject({
      ok: false,
      kind: "not-ready",
    });
  });
});

test("interrupting a hanging probe closes the inspector exactly once", async () => {
  const stub = injector({ hangAfterRoutines: 0 });
  const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const fiber = yield* Effect.forkScoped(
      stub.injector.deliverClaudeMessage("eng-1", "hi", { readyBudgetMs: 5_000 }),
    );
    while (stub.calls() < 2) yield* Effect.sleep(1);
    yield* Fiber.interrupt(fiber);
    return yield* Fiber.await(fiber);
  })));
  expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  expect(stub.closes()).toBe(1);
});
