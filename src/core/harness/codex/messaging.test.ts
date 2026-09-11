import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import type { HarnessSession } from "../types.ts";
import { CodexAppServerError } from "./app-server.ts";
import { createCodexMessenger } from "./messaging.ts";

const session = (
  id: string,
  managedName: string,
  lastActiveMs: number,
): HarnessSession => ({
  displayName: managedName,
  sessionId: id,
  tmuxSessionName: "task-codex",
  lastActiveMs,
  isLive: false,
  extras: { managedName, derivedState: "waiting", queued: 0 },
});

const target = { slug: "task", cwd: "/tmp/task", text: "keep going" };

function fakes(options: {
  sessions?: HarnessSession[];
  live?: boolean;
  liveKnown?: boolean;
  stampedId?: string;
  nativeFailure?: CodexAppServerError;
  cli?: { ok: boolean; reason?: string; unsupported?: boolean };
  terminalFails?: boolean;
  unstamped?: boolean;
} = {}) {
  const calls: string[] = [];
  const deps = {
    discover: () => {
      calls.push("discover");
      return Effect.succeed(options.sessions ?? [session("primary-id", "primary", 1)]);
    },
    liveInventory: () => {
      calls.push("live");
      return Effect.succeed({
        known: options.liveKnown !== false,
        all: new Set(options.live === false ? [] : ["task-codex"]),
        harnessSessionIds: new Map(
          options.live !== false && !options.unstamped
            ? [["task-codex", options.stampedId ?? "primary-id"]]
            : [],
        ),
      });
    },
    start: (_slug: string, _cwd: string, _harness: "claude" | "codex" | "opencode", _name?: string | null) => {
      calls.push("start");
      return Effect.succeed({ ok: true as const });
    },
    nativeQueue: ({ threadId }: { threadId: string; text: string }) => {
      calls.push(`native:${threadId}`);
      return options.nativeFailure
        ? Effect.fail(options.nativeFailure)
        : Effect.succeed({
            submission: { id: "q1", input: [], clientUserMessageId: "c1" },
            state: "started" as const,
            reconciled: false,
          });
    },
    cliQueue: (threadId: string) => {
      calls.push(`cli:${threadId}`);
      return Effect.succeed(options.cli ?? { ok: true });
    },
    terminal: ({ sessionId }: { sessionId: string }) => {
      calls.push(`terminal:${sessionId}`);
      if (options.terminalFails) {
        return Effect.succeed({ ok: false as const, reason: "Codex is not safe for terminal input (question)" });
      }
      return Effect.succeed({
        ok: true as const,
        coldStarted: false,
        delivered: true,
        resent: false,
      });
    },
    liveTerminal: () => {
      calls.push("live-terminal");
      return Effect.succeed({
        ok: true as const,
        coldStarted: false,
        delivered: null,
        resent: false,
      });
    },
    bootstrapTerminal: () => {
      calls.push("bootstrap");
      return Effect.succeed({
        ok: true as const,
        coldStarted: false,
        delivered: null,
        resent: false,
      });
    },
  };
  return { calls, send: createCodexMessenger(deps) };
}

const appError = (kind: CodexAppServerError["kind"]) => new CodexAppServerError({
  operation: kind === "absent" ? "connect" : "queue-add",
  kind,
  detail: `${kind} failure`,
});

describe("Codex message orchestration", () => {
  test("wakes a cold primary before native queue delivery", async () => {
    const fake = fakes({ live: false });
    const result = await Effect.runPromise(fake.send(target));

    expect(result).toMatchObject({
      ok: true,
      transport: "codex-app-server",
      coldStarted: true,
      delivered: true,
      queueState: "started",
    });
    expect(fake.calls).toEqual(["live", "discover", "start", "native:primary-id"]);
  });

  test("addresses the mapped primary when a newer secondary rollout exists", async () => {
    const fake = fakes({
      stampedId: "primary-id",
      sessions: [session("primary-id", "primary", 1), session("second-id", "2", 2)],
    });
    await Effect.runPromise(fake.send(target));
    expect(fake.calls).toContain("native:primary-id");
    expect(fake.calls).not.toContain("native:second-id");
    expect(fake.calls).not.toContain("start");
  });

  test("addresses an explicitly resumed secondary by its live tmux stamp", async () => {
    const fake = fakes({
      stampedId: "second-id",
      sessions: [session("primary-id", "primary", 2), session("second-id", "2", 1)],
    });
    await Effect.runPromise(fake.send(target));
    expect(fake.calls).toContain("native:second-id");
    expect(fake.calls).not.toContain("native:primary-id");
  });

  test("uses codex queue when the user-managed daemon is absent", async () => {
    const fake = fakes({ nativeFailure: appError("absent") });
    const result = await Effect.runPromise(fake.send(target));
    expect(result).toMatchObject({ ok: true, transport: "codex-queue", delivered: true });
    expect(fake.calls).toContain("cli:primary-id");
    expect(fake.calls.some((call) => call.startsWith("terminal:"))).toBe(false);
  });

  test("never retries or types after an ambiguous native write", async () => {
    const fake = fakes({ nativeFailure: appError("ambiguous") });
    const result = await Effect.runPromise(fake.send(target));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.reason).toContain("did not retry");
    expect(fake.calls.some((call) => call.startsWith("cli:") || call.startsWith("terminal:"))).toBe(false);
  });

  test("terminal fallback is reserved for a definitively unsupported queue", async () => {
    const fake = fakes({ nativeFailure: appError("unsupported") });
    const result = await Effect.runPromise(fake.send(target));
    expect(result).toMatchObject({ ok: true, transport: "terminal" });
    expect(fake.calls).toContain("terminal:primary-id");
  });

  test("slash commands execute through the guarded exact-thread terminal path", async () => {
    const fake = fakes();
    const result = await Effect.runPromise(fake.send({ ...target, text: "/compact focus" }));

    expect(result).toMatchObject({
      ok: true,
      transport: "terminal",
      delivered: null,
    });
    expect(fake.calls).toContain("terminal:primary-id");
    expect(fake.calls.some((call) => call.startsWith("native:") || call.startsWith("cli:"))).toBe(false);
  });

  test("an unsafe slash command is refused instead of entering a queue", async () => {
    const fake = fakes({ terminalFails: true });
    const result = await Effect.runPromise(fake.send({ ...target, text: "/compact" }));

    expect(result).toEqual({ ok: false, reason: "Codex is not safe for terminal input (question)" });
    expect(fake.calls).toContain("terminal:primary-id");
    expect(fake.calls.some((call) => call.startsWith("native:") || call.startsWith("cli:"))).toBe(false);
  });

  test("a UUID-less slash command uses the guarded live-pane path", async () => {
    const fake = fakes({ sessions: [], live: true, unstamped: true });
    const result = await Effect.runPromise(fake.send({ ...target, text: "/compact" }));

    expect(result).toMatchObject({ ok: true, transport: "terminal", delivered: null });
    expect(fake.calls).toContain("live-terminal");
    expect(fake.calls).not.toContain("bootstrap");
  });

  test("a cold UUID-less slash command starts once then waits on the live pane", async () => {
    const fake = fakes({ sessions: [], live: false });
    const result = await Effect.runPromise(fake.send({ ...target, text: "/compact" }));

    expect(result).toMatchObject({ ok: true, transport: "terminal", coldStarted: true, delivered: null });
    expect(fake.calls).toEqual(["live", "discover", "start", "discover", "live-terminal"]);
  });

  test("a failed CLI queue is treated as ambiguous and is never typed", async () => {
    const fake = fakes({
      nativeFailure: appError("absent"),
      cli: { ok: false, reason: "connection dropped" },
    });
    const result = await Effect.runPromise(fake.send(target));
    expect(result).toMatchObject({ ok: false });
    expect(fake.calls.some((call) => call.startsWith("terminal:"))).toBe(false);
  });

  test("bootstraps only a thread that has no UUID yet", async () => {
    const fake = fakes({ sessions: [], live: false });
    const result = await Effect.runPromise(fake.send(target));
    expect(result).toMatchObject({ ok: true, transport: "terminal", delivered: null });
    expect(fake.calls).toContain("bootstrap");
    expect(fake.calls).not.toContain("live-terminal");
    expect(fake.calls.some((call) => call.startsWith("native:"))).toBe(false);
  });

  test("falls back to the exact live tmux slot when no UUID can be recovered", async () => {
    const fake = fakes({ sessions: [], live: true, unstamped: true });
    const result = await Effect.runPromise(fake.send(target));
    expect(result).toMatchObject({
      ok: true,
      transport: "terminal",
      coldStarted: false,
      fallbackReason: "the live Codex slot has no recoverable thread UUID",
    });
    expect(fake.calls).toContain("live-terminal");
    expect(fake.calls).not.toContain("bootstrap");
    expect(fake.calls.some((call) => call.startsWith("native:"))).toBe(false);
  });

  test("a live unstamped slot never infers ownership from the primary name map", async () => {
    const fake = fakes({
      live: true,
      unstamped: true,
      sessions: [session("primary-id", "primary", 1)],
    });
    const result = await Effect.runPromise(fake.send(target));

    expect(result).toMatchObject({
      ok: true,
      transport: "terminal",
      fallbackReason: "the live Codex slot has no recoverable thread UUID",
    });
    expect(fake.calls).toContain("live-terminal");
    expect(fake.calls).not.toContain("native:primary-id");
  });

  test("fails closed when tmux liveness cannot be read", async () => {
    const fake = fakes({ sessions: [], live: false, liveKnown: false });
    const result = await Effect.runPromise(fake.send(target));
    expect(result).toMatchObject({ ok: false });
    expect(fake.calls).toEqual(["live"]);
  });
});
