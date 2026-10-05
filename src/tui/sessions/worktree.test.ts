import { expect, spyOn, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";

import * as attach from "../../core/tmux/attach.ts";
import * as admin from "../../core/tmux/admin.ts";
import * as handoff from "./renderer-handoff.ts";
import { enterWorktreeSession, type EnterWorktreeSessionOptions } from "./worktree.ts";
import { enterRemoteWorktreeSession } from "./remote.ts";
import { remoteWorktreeTarget } from "../../core/worktree-target.ts";

function options(): EnterWorktreeSessionOptions {
  return {
    renderer: {} as EnterWorktreeSessionOptions["renderer"],
    slug: "startup-proof", cwd: "/tmp/startup-proof", initial: "harness",
    diffBase: "main", harness: { harnessId: "codex", freshSlot: true },
  };
}

test("slow preparation keeps terminal ownership, rejects duplicate handoffs, then attaches once", async () => {
  const calls: string[] = [];
  const opts = options();
  const started = Deferred.makeUnsafe<void>();
  const ready = Deferred.makeUnsafe<void>();
  const prepare = spyOn(attach, "prepareAttachOrCreate").mockImplementation(() => Effect.gen(function* () {
    calls.push("prepare");
    yield* Deferred.succeed(started, undefined);
    yield* Deferred.await(ready);
    return { attach: Effect.sync(() => { calls.push("attach"); return { kind: "detached" as const }; }) };
  }));
  const kill = spyOn(admin, "killHarnessSession").mockImplementation(() => Effect.sync(() => { calls.push("replace"); }));
  const terminal = spyOn(handoff, "handoffTerminal").mockImplementation((_renderer, _cwd, effect) =>
    Effect.sync(() => { calls.push("handoff"); }).pipe(Effect.andThen(effect)),
  );
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Effect.forkChild(enterWorktreeSession(opts));
      yield* Deferred.await(started);
      expect(calls).toEqual(["prepare"]);
      const duplicate = yield* enterWorktreeSession(opts);
      expect(duplicate.kind).toBe("spawn-failed");
      const remote = yield* Effect.exit(enterRemoteWorktreeSession({
        renderer: opts.renderer,
        worktree: remoteWorktreeTarget({
          slug: "remote-proof", branch: "main", path: "/unused", stage: "test",
          remote: { host: "test", label: "test", wtPath: "wt" },
        }),
        target: "harness", harnessId: "codex",
      }));
      expect(remote._tag).toBe("Failure");
      expect(calls).toEqual(["prepare"]);
      yield* Deferred.succeed(ready, undefined);
      expect(yield* Fiber.join(first)).toEqual({ kind: "detached" });
    }));
    expect(calls).toEqual(["prepare", "handoff", "replace", "attach"]);
    // Finishing releases the transition guard, so a later explicit F12 works.
    expect(await Effect.runPromise(enterWorktreeSession(opts))).toEqual({ kind: "detached" });
    expect(calls.filter((call) => call === "attach")).toHaveLength(2);
  } finally { prepare.mockRestore(); kill.mockRestore(); terminal.mockRestore(); }
});

test("failed preparation preserves the old slot and never suspends the board", async () => {
  const prepare = spyOn(attach, "prepareAttachOrCreate").mockReturnValue(Effect.fail(
    new attach.AttachOperationError({ message: "daemon not ready", cause: null }),
  ));
  const kill = spyOn(admin, "killHarnessSession").mockImplementation(() => Effect.void);
  const terminal = spyOn(handoff, "handoffTerminal");
  const opts = options();
  try {
    expect((await Effect.runPromiseExit(enterWorktreeSession(opts)))._tag).toBe("Failure");
    expect(kill).not.toHaveBeenCalled();
    expect(terminal).not.toHaveBeenCalled();
    // A second attempt actually prepares again instead of retaining a stale guard.
    expect((await Effect.runPromiseExit(enterWorktreeSession(opts)))._tag).toBe("Failure");
    expect(prepare).toHaveBeenCalledTimes(2);
  } finally { prepare.mockRestore(); kill.mockRestore(); terminal.mockRestore(); }
});

test("cancelled preparation releases the handoff guard without replacing a slot", async () => {
  const started = Deferred.makeUnsafe<void>();
  const prepare = spyOn(attach, "prepareAttachOrCreate").mockImplementation(() =>
    Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
  );
  const kill = spyOn(admin, "killHarnessSession").mockImplementation(() => Effect.void);
  const opts = options();
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const first = yield* Effect.forkChild(enterWorktreeSession(opts));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(first);
      prepare.mockReturnValue(Effect.fail(new attach.AttachOperationError({ message: "second attempt", cause: null })));
      expect((yield* Effect.exit(enterWorktreeSession(opts)))._tag).toBe("Failure");
    }));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(kill).not.toHaveBeenCalled();
  } finally { prepare.mockRestore(); kill.mockRestore(); }
});
