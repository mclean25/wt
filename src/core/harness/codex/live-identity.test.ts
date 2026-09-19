import { expect, test } from "bun:test";
import { Effect } from "effect";

import { ProcSpawnError, type RunResult } from "../../proc.ts";
import type { HarnessSession } from "../types.ts";
import { codexWriterIdentity, recoverCodexLiveIdentity } from "./live-identity.ts";

const root = "01900000-0000-7000-8000-000000000001";
const other = "01900000-0000-7000-8000-000000000002";
const child = "01900000-0000-7000-8000-000000000003";
const sessions = (...ids: string[]): HarnessSession[] => ids.map((sessionId) => ({
  sessionId, displayName: "primary", tmuxSessionName: "target-codex", lastActiveMs: null,
  isLive: false, extras: { managedName: null, derivedState: null, queued: 0 },
}));
const lock = (id: string) => `n/Users/test/.codex/thread-writer-locks/${id}.lock\n`;
const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0 });

test("writer identity excludes nonroot locks and deduplicates open descriptors", () => {
  expect(codexWriterIdentity(lock(child) + lock(root) + lock(root), sessions(root))).toBe(root);
  expect(codexWriterIdentity(lock(child), sessions(root))).toBeNull();
  expect(codexWriterIdentity(lock(root) + lock(other), sessions(root, other))).toBeNull();
  expect(codexWriterIdentity(`n/tmp/${root}.lock\n` + lock(root).trim() + ".old\n", sessions(root))).toBeNull();
});

test("live identity rechecks exact single-pane pid and bounds every subprocess", async () => {
  const results = [ok("123\n"), ok(lock(root) + lock(child)), ok("123\n")];
  const seen: string[][] = [];
  const id = await Effect.runPromise(recoverCodexLiveIdentity("target-codex", sessions(root), (args, opts) => {
    seen.push([...args]);
    expect(opts.timeoutMs).toBe(2_000);
    return Effect.succeed(results.shift()!);
  }));
  expect(id).toBe(root);
  expect(seen[0]).toContain("=target-codex");
  expect(seen[0]).toContain("-s");
  expect(seen[1]).toEqual(["lsof", "-nP", "-a", "-p", "123", "-Fn"]);
  expect(seen[2]).toEqual(seen[0]);
});

test("inspection fails closed on changed pid, multiple panes, process errors and timeouts", async () => {
  for (const results of [
    [ok("123\n"), ok(lock(root)), ok("124\n")],
    [ok("123\n124\n")],
    [ok("123\n"), { ...ok(lock(root)), exitCode: 1 }],
    [ok("123\n"), { ...ok(lock(root)), timedOut: true }],
    [ok("123\n"), ok(lock(root)), { ...ok("123\n"), timedOut: true }],
  ]) {
    expect(await Effect.runPromise(recoverCodexLiveIdentity("target-codex", sessions(root), () =>
      Effect.succeed(results.shift()!)))).toBeNull();
  }
  expect(await Effect.runPromise(recoverCodexLiveIdentity("target-codex", sessions(root), () =>
    Effect.fail(new ProcSpawnError({ argv: ["tmux"], cause: "permission denied" }))))).toBeNull();
});
