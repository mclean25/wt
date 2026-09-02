import { afterEach, describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  createSessionMessengerPromise,
  createSessionMessenger,
  fallbackAdvice,
  senderTag,
  stampSender,
  type FallbackCause,
  type SessionMessageTarget,
} from "./session-messaging.ts";
import type { InjectFailureKind, InjectOutcome } from "./claude/inject.ts";
import type { RegistryStatus } from "./claude/registry.ts";

/**
 * Run under a virtual clock so the 8s transcript-confirmation budget is
 * free: fork, advance the TestClock past it, then join. Only the tests
 * that exhaust that whole budget (confirmation never lands) need this —
 * everything else resolves before its first scheduled sleep.
 */
const withVirtualTime = <A, E>(effect: Effect.Effect<A, E>, advanceMs = 10_000): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(effect);
      yield* TestClock.adjust(advanceMs);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );

const original = process.env.WT_AGENT;

afterEach(() => {
  if (original === undefined) delete process.env.WT_AGENT;
  else process.env.WT_AGENT = original;
});

describe("sender stamping", () => {
  test("a message from a worktree agent is signed with its slug", () => {
    process.env.WT_AGENT = "eng-4821-fix-login";
    expect(stampSender("the retry loop is the culprit")).toBe(
      "[eng-4821-fix-login] the retry loop is the culprit",
    );
  });

  test("outside a harness session nothing is stamped", () => {
    // The TUI and a human's shell are not agents; signing their
    // messages as one would tell the manager it's coordinating a worker
    // when it's answering a person.
    delete process.env.WT_AGENT;
    expect(senderTag()).toBeNull();
    expect(stampSender("plain text")).toBe("plain text");
  });

  test("an empty or whitespace WT_AGENT is no identity at all", () => {
    process.env.WT_AGENT = "   ";
    expect(senderTag()).toBeNull();
  });

  test("an already-attributed message keeps its own framing", () => {
    // `[re: <slug>]` briefings say what the message is ABOUT; stacking a
    // sender tag in front would read as two subjects.
    process.env.WT_AGENT = "manager";
    expect(stampSender("[re: eng-1] status please")).toBe("[re: eng-1] status please");
  });

  test("a slash command is never stamped — a tag would stop it running", () => {
    // Injection submits at the prompt, so `/compact` executes. It only
    // executes while it is the FIRST token, so stamping it would turn a
    // command back into a paragraph about the command.
    process.env.WT_AGENT = "wt";
    expect(stampSender("/compact")).toBe("/compact");
    expect(stampSender("/compact keep the fleet state")).toBe("/compact keep the fleet state");
  });

  test("a dollar-prefixed Codex/OpenCode skill is never stamped", () => {
    process.env.WT_AGENT = "wt";
    expect(stampSender("$start")).toBe("$start");
    expect(stampSender("$handoff next task")).toBe("$handoff next task");
  });

  test("a message that merely mentions a path or a command is stamped", () => {
    process.env.WT_AGENT = "wt";
    expect(stampSender("/Users/michael/x.ts is where it broke")).toBe(
      "[wt] /Users/michael/x.ts is where it broke",
    );
    expect(stampSender("run /compact when the footer goes red")).toBe(
      "[wt] run /compact when the footer goes red",
    );
  });
});

type FakeOpts = {
  status?: RegistryStatus;
  waitingFor?: string | null;
  /** Status observed on the re-reads during the readiness wait. */
  becomes?: { status: RegistryStatus; waitingFor: string | null };
  coldStarted?: boolean;
  deliverFails?: InjectFailureKind;
  terminalFails?: boolean;
  landed?: boolean;
};

function fakes(opts: FakeOpts = {}) {
  const calls = { deliver: 0, terminal: 0, ensure: 0, statusOf: 0 };
  const warnings: string[] = [];
  const locks: string[] = [];
  let readyBudget: number | null = null;
  const deps = {
    inspectorEnabled: () => true,
    ensureInfo: () => {
      calls.ensure += 1;
      return Effect.succeed({
        session: {
          status: opts.status ?? ("idle" as RegistryStatus),
          waitingFor: opts.waitingFor ?? null,
        },
        coldStarted: opts.coldStarted ?? false,
      });
    },
    statusOf: () => {
      calls.statusOf += 1;
      return (
        opts.becomes ?? {
          status: opts.status ?? ("idle" as RegistryStatus),
          waitingFor: opts.waitingFor ?? null,
        }
      );
    },
    deliver: (
      _name: string,
      _text: string,
      o: { readyBudgetMs: number; abortIfBlocked?: () => string | null },
    ): Effect.Effect<InjectOutcome> => {
      calls.deliver += 1;
      readyBudget = o.readyBudgetMs;
      // The injector polls this throughout its readiness wait; a
      // dialog that appears mid-wait must abort rather than fall back.
      const blocked = o.abortIfBlocked?.();
      if (blocked) return Effect.succeed({ ok: false, kind: "blocked", reason: blocked });
      if (opts.deliverFails) {
        return Effect.succeed({
          ok: false,
          kind: opts.deliverFails,
          reason: `probe says ${opts.deliverFails}`,
        });
      }
      return Effect.succeed({ ok: true, draftPreserved: false });
    },
    terminal: () => {
      calls.terminal += 1;
      if (opts.terminalFails) return Effect.succeed({ ok: false as const, reason: "no pane either" });
      return Effect.succeed({ ok: true as const, coldStarted: false, delivered: true, resent: false });
    },
    landed: () => opts.landed ?? true,
    warn: (_slug: string, message: string) => {
      warnings.push(message);
    },
    lock: <A, E>(key: string, effect: Effect.Effect<A, E>): Effect.Effect<A, E> => {
      locks.push(key);
      return effect;
    },
  };
  return { deps, calls, warnings, locks, readyBudget: () => readyBudget };
}

const target: SessionMessageTarget = {
  slug: "eng-1",
  cwd: "/tmp/eng-1",
  harnessId: "claude",
  managedName: null,
  text: "carry on",
};

describe("the claude transport ladder", () => {
  afterEach(() => {
    delete process.env.WT_AGENT;
  });

  test("an injectable session is submitted into, never typed at", async () => {
    const fake = fakes();
    const send = createSessionMessengerPromise(fake.deps);

    expect(await send(target)).toMatchObject({ ok: true, transport: "inspector" });
    expect(fake.calls.deliver).toBe(1);
    expect(fake.calls.terminal).toBe(0);
    expect(fake.warnings).toEqual([]);
  });

  test("delivery is serialized per target conversation", async () => {
    // The manager slot is a real multi-writer singleton; two overlapping
    // injections each restore their own captured draft on a timer, and
    // the later timer wins.
    const fake = fakes();
    const send = createSessionMessengerPromise(fake.deps);

    await send(target);

    expect(fake.locks).toEqual(["__claude_send__eng-1"]);
  });

  test("no socket at all falls back to typing, and says why", async () => {
    // The session predates this wt, or a human started it by hand.
    const fake = fakes({ deliverFails: "absent" });
    const send = createSessionMessengerPromise(fake.deps);

    expect(await send(target)).toMatchObject({
      ok: true,
      transport: "terminal",
      fallback: { kind: "absent" },
    });
    expect(fake.calls.terminal).toBe(1);
    expect(fake.warnings[0]).toContain("has no inspector socket");
  });

  test("a stale socket falls back to typing, with restart advice", async () => {
    const fake = fakes({ deliverFails: "stale" });
    const send = createSessionMessengerPromise(fake.deps);

    expect(await send(target)).toMatchObject({
      ok: true,
      transport: "terminal",
      fallback: { kind: "stale" },
    });
    expect(fake.warnings[0]).toContain("died with a restart");
  });

  test("a prompt UI that never mounts is typed at, blaming the anchors", async () => {
    const fake = fakes({ deliverFails: "not-ready" });
    const send = createSessionMessengerPromise(fake.deps);

    expect(await send(target)).toMatchObject({
      ok: true,
      transport: "terminal",
      fallback: { kind: "not-ready" },
    });
    expect(fake.warnings[0]).toContain("moved the injector's anchors");
  });

  test("no fallback advice orders the reader to restart a session", () => {
    // The reader is usually an agent messaging a peer that is mid-turn,
    // and the message it is attached to was DELIVERED. An imperative
    // here reads as "kill that conversation to fix this", which costs
    // the peer its in-flight work and fixes nothing that was broken.
    const causes: FallbackCause[] = [
      { kind: "disabled" },
      { kind: "unsupported", harnessId: "codex" },
      { kind: "absent", reason: "no socket" },
      { kind: "stale", reason: "econnrefused" },
      { kind: "not-ready", reason: "prompt not found" },
      { kind: "blocked", reason: "waiting" },
      { kind: "submitted-unknown", reason: "no answer" },
      { kind: "failed", reason: "submit threw" },
    ];
    for (const cause of causes) {
      const advice = fallbackAdvice(cause);
      expect(advice.length).toBeGreaterThan(0);
      expect(advice).not.toMatch(/\brestart (it|the session|that session)\b/);
    }
  });

  test("the sender's own off switch is not reported as a broken session", async () => {
    // WT_INSPECT=off degrades every send here by choice. Nothing about
    // the TARGET is wrong, and nothing about it needs fixing.
    const fake = fakes();
    const send = createSessionMessengerPromise({ ...fake.deps, inspectorEnabled: () => false });

    const res = await send(target);
    expect(res).toMatchObject({
      ok: true,
      transport: "terminal",
      fallback: { kind: "disabled" },
    });
    expect(fake.calls.deliver).toBe(0);
    // Not a degradation worth an attention line: it was asked for.
    expect(fake.warnings).toEqual([]);
  });

  test("a session waiting on a human is never typed at", async () => {
    // The submit key would answer whatever dialog is up — deciding a
    // permission on the human's behalf.
    const fake = fakes({ status: "waiting", waitingFor: "permission prompt" });
    const send = createSessionMessengerPromise(fake.deps);

    const res = await send(target);
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.reason).toContain("permission prompt");
    expect(fake.calls.terminal).toBe(0);
    expect(fake.calls.deliver).toBe(0);
  });

  test("a dialog that appears DURING the readiness wait also blocks typing", async () => {
    // The dangerous case: the status check passed, then a permission
    // prompt came up. To the injector's probe that is indistinguishable
    // from a prompt that hasn't mounted yet, so without re-reading the
    // status wt would fall back and type into the dialog.
    const fake = fakes({
      status: "idle",
      becomes: { status: "waiting", waitingFor: "permission prompt" },
    });
    const send = createSessionMessengerPromise(fake.deps);

    const res = await send(target);
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.reason).toContain("permission prompt");
    expect(fake.calls.terminal).toBe(0);
  });

  test("an unacknowledged submit is confirmed, never retyped", async () => {
    // The call carrying onSubmit is already on the wire; closing our end
    // doesn't cancel it, so typing the same text would double-submit.
    const fake = fakes({ deliverFails: "submitted-unknown", landed: true });
    const send = createSessionMessengerPromise(fake.deps);

    expect(await send(target)).toMatchObject({ ok: true, transport: "inspector", delivered: true });
    expect(fake.calls.terminal).toBe(0);
  });

  test("an unacknowledged submit that never lands fails loudly about the duplicate risk", async () => {
    const fake = fakes({ deliverFails: "submitted-unknown", landed: false });
    const send = createSessionMessenger(fake.deps);

    const res = await withVirtualTime(send(target));
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.reason).toContain("duplicate is possible");
    expect(fake.calls.terminal).toBe(0);
  });

  test("WT_INSPECT=off forces typing without probing anything", async () => {
    const fake = fakes();
    const send = createSessionMessengerPromise({ ...fake.deps, inspectorEnabled: () => false });

    expect(await send(target)).toMatchObject({ ok: true, transport: "terminal" });
    expect(fake.calls.deliver).toBe(0);
    expect(fake.calls.ensure).toBe(0);
  });

  test("one warning per session per failure kind, not one per message", async () => {
    // A fleet-wide nudge across a degraded session must not produce a
    // wall of identical attention lines.
    const fake = fakes({ deliverFails: "absent" });
    const send = createSessionMessengerPromise(fake.deps);

    await send(target);
    await send(target);
    await send(target);

    expect(fake.warnings).toHaveLength(1);
  });

  test("a cold start gets the longer readiness budget, and says it cold-started", async () => {
    const fake = fakes({ coldStarted: true });
    const send = createSessionMessengerPromise(fake.deps);

    expect(await send(target)).toMatchObject({ ok: true, coldStarted: true });
    expect(fake.readyBudget()).toBe(20_000);
  });

  test("a warm session gets the short budget", async () => {
    const fake = fakes();
    const send = createSessionMessengerPromise(fake.deps);

    await send(target);

    expect(fake.readyBudget()).toBe(4_000);
  });

  test("when the pane is gone too, the failure is reported, not papered over", async () => {
    const fake = fakes({ deliverFails: "absent", terminalFails: true });
    const send = createSessionMessengerPromise(fake.deps);

    const res = await send(target);
    expect(res).toMatchObject({ ok: false });
    expect(res.ok === false && res.reason).toBe("no pane either");
  });

  test("a queued message on a busy session counts as delivered", async () => {
    // Submitting mid-turn queues, exactly as typing would, and the
    // transcript won't show it until that turn ends — which can be many
    // minutes. Reporting it lost would be a lie the caller acts on.
    const fake = fakes({ status: "busy", landed: false });
    const send = createSessionMessenger(fake.deps);

    expect(await withVirtualTime(send(target))).toMatchObject({
      transport: "inspector",
      delivered: true,
    });
  });

  test("an unrecognized status is treated as possibly-busy, not as idle", async () => {
    // `unknown` is registry.ts's forward-compat net for a Claude status
    // wt doesn't know yet. Assuming it means idle would report a real
    // queued message as lost the first time Claude adds one.
    const fake = fakes({ status: "unknown", landed: false });
    const send = createSessionMessenger(fake.deps);

    expect(await withVirtualTime(send(target))).toMatchObject({ delivered: true });
  });

  test("an idle session that never records the prompt really did lose it", async () => {
    const fake = fakes({ status: "idle", landed: false });
    const send = createSessionMessenger(fake.deps);

    expect(await withVirtualTime(send(target))).toMatchObject({
      transport: "inspector",
      delivered: false,
    });
  });

  test("a slash command reports delivery as unknown, not as lost", async () => {
    // It runs — but Claude records an expanded command entry, not the
    // submitted text, so the transcript can never witness it. Reporting
    // it as a failure made a working `/context` look broken.
    const fake = fakes({ landed: false });
    const send = createSessionMessengerPromise(fake.deps);

    expect(await send({ ...target, text: "/context" })).toMatchObject({
      ok: true,
      transport: "inspector",
      delivered: null,
    });
  });

  test("a dollar-prefixed harness command is also left executable", async () => {
    process.env.WT_AGENT = "wt";
    const fake = fakes();
    const send = createSessionMessengerPromise(fake.deps);

    await send({ ...target, harnessId: "codex", text: "$start" });

    expect(fake.calls.terminal).toBe(1);
  });

  test("an empty message is refused before any transport is touched", async () => {
    const fake = fakes();
    const send = createSessionMessengerPromise(fake.deps);

    expect(await send({ ...target, text: "   " })).toMatchObject({ ok: false });
    expect(fake.calls.deliver).toBe(0);
    expect(fake.calls.terminal).toBe(0);
  });

  test("other harnesses go straight to their pane", async () => {
    const fake = fakes();
    const send = createSessionMessengerPromise(fake.deps);

    expect(await send({ ...target, harnessId: "codex" })).toMatchObject({
      ok: true,
      transport: "terminal",
      // Not a fallback from a broken injector — codex never had one.
      fallback: { kind: "unsupported", harnessId: "codex" },
    });
    expect(fake.calls.ensure).toBe(0);
  });

  test("interrupting Effect delivery aborts the inspector without terminal fallback", async () => {
    const fake = fakes();
    let entered = false;
    const send = createSessionMessenger({
      ...fake.deps,
      deliver: () =>
        Effect.sync(() => {
          entered = true;
        }).pipe(Effect.andThen(Effect.never)),
    });
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const fiber = yield* Effect.forkScoped(send(target));
      while (!entered) yield* Effect.sleep(1);
      yield* Fiber.interrupt(fiber);
      return yield* Fiber.await(fiber);
    })));
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(fake.calls.terminal).toBe(0);
  });

  test("interrupting transcript confirmation stops polling and never falls back", async () => {
    const fake = fakes({ landed: false });
    let polls = 0;
    const send = createSessionMessenger({
      ...fake.deps,
      landed: () => {
        polls += 1;
        return false;
      },
    });
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(send(target));
          while (polls === 0) yield* Effect.sleep(1);
          yield* Fiber.interrupt(fiber);
          return yield* Fiber.await(fiber);
        }),
      ),
    );
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(fake.calls.terminal).toBe(0);
  });
});
