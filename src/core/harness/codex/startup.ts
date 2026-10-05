import { Clock, Data, Duration, Effect } from "effect";

import {
  CodexAppServerError,
  withCodexAppServer,
  type CodexAppServerDependencies,
  type CodexExperimentalFeaturePage,
} from "./app-server.ts";

const STARTUP_BUDGET_MS = 30_000;
const PAGE_LIMIT = 10;

export class CodexStartupReadinessError extends Data.TaggedError("CodexStartupReadinessError")<{
  readonly detail: string;
}> {
  override get message(): string { return this.detail; }
}

export type CodexStartupReadiness =
  | {
      readonly kind: "ready";
      readonly elapsedMs: number;
      readonly features: number;
      readonly pages: number;
    }
  | {
      readonly kind: "defer";
      readonly reason: "socket-unavailable" | "unsupported";
      readonly elapsedMs: number;
    };

function noListener(error: CodexAppServerError): boolean {
  if (error.operation !== "connect") return false;
  if (error.kind === "absent") return true;
  let cause: unknown = error.cause;
  while (cause instanceof Error) {
    if ((cause as NodeJS.ErrnoException).code === "ECONNREFUSED") return true;
    cause = cause.cause;
  }
  return false;
}

/** Wait for the shared daemon's feature catalog once before handing off to its native TUI. */
export const waitForCodexStartup = Effect.fn("waitForCodexStartup")(function* (
  dependencies?: CodexAppServerDependencies,
  budgetMs = STARTUP_BUDGET_MS,
): Effect.fn.Return<CodexStartupReadiness, CodexAppServerError | CodexStartupReadinessError> {
  const started = yield* Clock.currentTimeMillis;
  const deadline = started + Math.max(0, budgetMs);
  const remaining = Effect.map(Clock.currentTimeMillis, (now) => Math.max(1, deadline - now));
  const work = withCodexAppServer((client) => Effect.gen(function* () {
    let cursor: string | null = null;
    let features = 0;
    let pages = 0;
    do {
      if (pages >= PAGE_LIMIT) {
        return yield* new CodexAppServerError({
          operation: "experimental-feature-list",
          kind: "protocol",
          detail: `Codex app-server experimentalFeature/list exceeded ${PAGE_LIMIT} pages`,
        });
      }
      const timeoutMs = yield* remaining;
      const page: CodexExperimentalFeaturePage = yield* client.experimentalFeatureList(cursor, timeoutMs);
      features += page.data.length;
      pages += 1;
      cursor = page.nextCursor;
    } while (cursor !== null);
    const elapsedMs = Math.max(0, (yield* Clock.currentTimeMillis) - started);
    return { kind: "ready" as const, elapsedMs, features, pages };
  }), dependencies, Math.max(1, budgetMs)).pipe(Effect.catch((error): Effect.Effect<CodexStartupReadiness, CodexAppServerError> => {
    if (error instanceof CodexAppServerError && noListener(error)) {
      return Effect.map(Clock.currentTimeMillis, (now) => ({
        kind: "defer" as const,
        reason: "socket-unavailable" as const,
        elapsedMs: Math.max(0, now - started),
      }));
    }
    if (error instanceof CodexAppServerError && error.kind === "unsupported") {
      return Effect.map(Clock.currentTimeMillis, (now) => ({
        kind: "defer" as const,
        reason: "unsupported" as const,
        elapsedMs: Math.max(0, now - started),
      }));
    }
    return Effect.fail(error);
  }));

  const result = yield* Effect.raceFirst(
    work,
    Effect.sleep(Duration.millis(Math.max(0, budgetMs))).pipe(Effect.as(null)),
  );
  if (result !== null) return result;
  return yield* new CodexStartupReadinessError({
    detail: `Codex background server did not finish startup readiness within ${budgetMs}ms; no new session started`,
  });
});
