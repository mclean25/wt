import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  CodexAppServerError,
  type CodexAppServerDependencies,
  type CodexAppServerTransport,
} from "./app-server.ts";
import { waitForCodexStartup } from "./startup.ts";

function dependencies(
  respond: (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>,
  timeouts: number[] = [],
): CodexAppServerDependencies {
  return {
    socketPath: () => "/fake/socket",
    clientVersion: "test",
    newClientUserMessageId: () => "unused",
    connect: async () => {
      const transport: CodexAppServerTransport = {
        request: async (method, params, _signal, timeoutMs) => {
          if (timeoutMs !== undefined) timeouts.push(timeoutMs);
          return respond(method, params);
        },
        notify: async () => {},
        close: () => {},
      };
      return transport;
    },
  };
}

const initialized = { userAgent: "codex", codexHome: "/tmp/codex" };

describe("Codex startup feature readiness", () => {
  test("loads every page sequentially on one connection with the remaining budget", async () => {
    const calls: string[] = [];
    const timeouts: number[] = [];
    const result = await Effect.runPromise(waitForCodexStartup(dependencies((method, params) => {
      calls.push(`${method}:${String(params.cursor)}`);
      if (method === "initialize") return initialized;
      if (method === "experimentalFeature/list") {
        return params.cursor === null
          ? { data: [{ name: "one" }], nextCursor: "next" }
          : { data: [{ name: "two" }], nextCursor: null };
      }
      throw new Error(`unexpected ${method}`);
    }, timeouts)));

    expect(result).toMatchObject({ kind: "ready", features: 2, pages: 2 });
    expect(calls).toEqual([
      "initialize:undefined",
      "experimentalFeature/list:null",
      "experimentalFeature/list:next",
    ]);
    expect(timeouts).toHaveLength(3);
    expect(timeouts.every((timeout) => timeout > 0 && timeout <= 30_000)).toBeTrue();
  });

  test("defers to native behavior when the API is unsupported", async () => {
    const result = await Effect.runPromise(waitForCodexStartup(dependencies((method) => {
      if (method === "initialize") return initialized;
      throw new CodexAppServerError({
        operation: "experimental-feature-list",
        kind: "unsupported",
        detail: "unknown method",
      });
    })));
    expect(result).toMatchObject({ kind: "defer", reason: "unsupported" });
  });

  test("bounds a hung request and closes the connection without retrying", async () => {
    let calls = 0;
    let closed = false;
    const deps = dependencies((method) => {
      if (method === "initialize") return initialized;
      calls += 1;
      return Promise.withResolvers<never>().promise;
    });
    const originalConnect = deps.connect;
    const closingDeps = { ...deps, connect: async (...args: Parameters<typeof originalConnect>) => {
      const transport = await originalConnect(...args);
      return { ...transport, close: () => { closed = true; transport.close(); } };
    } };
    const exit = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(waitForCodexStartup(closingDeps, 30_000));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(30_000);
      return yield* Fiber.await(fiber);
    }).pipe(Effect.provide(TestClock.layer())));
    expect(exit._tag).toBe("Failure");
    expect(calls).toBe(1);
    expect(closed).toBeTrue();
  });

  test("surfaces invalid protocol responses", async () => {
    const result = await Effect.runPromiseExit(waitForCodexStartup(dependencies((method) => {
      if (method === "initialize") return initialized;
      return { data: "not-an-array", nextCursor: null };
    })));
    expect(result._tag).toBe("Failure");
  });

  test("waits through a config read longer than the native five-second limit", async () => {
    const requested = Deferred.makeUnsafe<void>();
    const answer = Promise.withResolvers<unknown>();
    const deps = dependencies((method) => {
      if (method === "initialize") return initialized;
      Deferred.doneUnsafe(requested, Effect.void);
      return answer.promise;
    });
    await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(waitForCodexStartup(deps));
      yield* Deferred.await(requested);
      yield* TestClock.adjust(6_000);
      answer.resolve({ data: [], nextCursor: null });
      expect(yield* Fiber.join(fiber)).toMatchObject({ kind: "ready", elapsedMs: 6_000 });
    }).pipe(Effect.provide(TestClock.layer())));
  });

  test("only an absent socket or refused connection defers to native daemon startup", async () => {
    const base = dependencies(() => initialized);
    for (const code of ["ENOENT", "ECONNREFUSED", "ETIMEDOUT", "EACCES"]) {
      const deps = { ...base, connect: async () => { throw Object.assign(new Error(code), { code }); } };
      const result = await Effect.runPromiseExit(waitForCodexStartup(deps));
      expect(result._tag).toBe(code === "ENOENT" || code === "ECONNREFUSED" ? "Success" : "Failure");
    }
  });
});
