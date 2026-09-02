import { describe, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber, Ref } from "effect";

import {
  isStackTitleMetaOnly,
  parseTitleDescription,
  withNamingPermitEffect,
} from "./ai.ts";

describe("isStackTitleMetaOnly", () => {
  test("rejects a bare leaked meta word", () => {
    // The eng-5202 incident: the model handed back its own vocabulary.
    expect(isStackTitleMetaOnly("TUI")).toBe(true);
  });

  test("rejects a title built entirely from packaging words", () => {
    expect(isStackTitleMetaOnly("Header Stack Section")).toBe(true);
    expect(isStackTitleMetaOnly("Developer Tool Group")).toBe(true);
  });

  test("keeps a real title, even one that reuses a meta word as domain content", () => {
    // "header" is on the list, but "Stamp" anchors it — never strip to "Stamp".
    expect(isStackTitleMetaOnly("Header Stamp")).toBe(false);
    expect(isStackTitleMetaOnly("Atomic builder claim")).toBe(false);
    expect(isStackTitleMetaOnly("Orchestration Stack")).toBe(false);
  });

  test("empty input is not meta-only (nothing to reject)", () => {
    expect(isStackTitleMetaOnly("")).toBe(false);
    expect(isStackTitleMetaOnly("   ")).toBe(false);
  });

  test("is punctuation- and case-insensitive", () => {
    expect(isStackTitleMetaOnly("stack.")).toBe(true);
    expect(isStackTitleMetaOnly("BRANCHES")).toBe(true);
  });
});

test("a queued naming request cancelled before its permit never runs", async () => {
  const ran = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const acquired = yield* Deferred.make<void>();
    const count = yield* Ref.make(0);
    const holder = yield* Effect.forkScoped(withNamingPermitEffect(
      Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Deferred.await(release))),
    ));
    yield* Deferred.await(acquired);
    const queued = yield* Effect.forkScoped(withNamingPermitEffect(Ref.update(count, (n) => n + 1)));
    yield* Fiber.interrupt(queued);
    const queuedExit = yield* Fiber.await(queued);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    return { count: yield* Ref.get(count), interrupted: Exit.hasInterrupts(queuedExit) };
  })));
  expect(ran).toEqual({ count: 0, interrupted: true });
});

describe("parseTitleDescription", () => {
  test("extracts the naming contract from harness output", () => {
    expect(parseTitleDescription(
      "TITLE: Fix the thing\nBRIEF: Thing fix\nDESCRIPTION: Done.",
    )).toEqual({
      title: "Fix the thing",
      brief: "Thing fix",
      description: "Done.",
    });
  });

  test("tolerates harness noise around the formatted answer", () => {
    expect(parseTitleDescription(
      "startup notice\nTITLE: Fix the thing\nBRIEF: Thing fix\nDESCRIPTION: Done.",
    ).title).toBe("Fix the thing");
  });
});
