import { describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import type { RunResult } from "../proc.ts";
import { enqueueAsyncMerge } from "./async-merge.ts";

const uuid = "630b9d5e-3f2a-4f7e-8b0c-2d5f9a8c1e42";
const sha = "a".repeat(40);
const pending = (changes: Record<string, unknown> = {}) => ({
  status: "pending", details: {
    message: "Merge request enqueued", uuid, expected_head_sha: sha,
    merge_action: "merge_queue", merge_method: "default", bypass_rules: false, ...changes,
  },
});
function http(code: number, body: unknown): RunResult {
  return { stdout: `HTTP/2.0 ${code} Status\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
    stderr: code >= 400 ? `gh: HTTP ${code}` : "", exitCode: code >= 400 ? 1 : 0 };
}
const enqueued = http(200, { status: "enqueued", details: { message: "In merge queue" } });

async function scenario(results: RunResult[], advance = 0) {
  const calls: string[][] = [];
  const value = await Effect.runPromise(Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(enqueueAsyncMerge("owner/repo", 42, sha, (argv) => {
      calls.push(argv);
      return Effect.succeed(results[Math.min(calls.length - 1, results.length - 1)]!);
    }));
    yield* Effect.yieldNow;
    if (advance) yield* TestClock.adjust(advance);
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(TestClock.layer())));
  return { value, calls };
}

describe("async merge queue", () => {
  test("sends fixed SHA and explicit queue-only, non-bypass options", async () => {
    const { value, calls } = await scenario([enqueued]);
    expect(value).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`sha=${sha}`);
    expect(calls[0]).toContain("merge_action=merge_queue");
    expect(calls[0]).toContain("bypass_rules=false");
  });

  test("202 waits for terminal success and polls only the returned UUID", async () => {
    const { value, calls } = await scenario([http(202, pending()), http(200, pending()), enqueued], 2_000);
    expect(value).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
    expect(calls.filter((args) => args.includes("PUT"))).toHaveLength(1);
    expect(calls[1]).toContain(`repos/owner/repo/pulls/42/merge-async/${uuid}`);
  });

  test("already merged is terminal success", async () => {
    const { value } = await scenario([http(200, { status: "merged", details: { message: "Already merged", sha } })]);
    expect(value).toEqual({ ok: true });
  });

  test("409 attaches to an existing identical request, including omitted default bypass", async () => {
    const { value, calls } = await scenario([http(409, pending({ bypass_rules: undefined })), enqueued], 1_000);
    expect(value).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  test.each([
    { expected_head_sha: "different" }, { merge_action: "direct_merge" },
    { bypass_rules: true }, { uuid: "../../other" },
    { merge_method: undefined },
  ])("409 refuses mismatched request options %j", async (changes) => {
    const { value, calls } = await scenario([http(409, pending(changes))]);
    expect(value.ok).toBe(false);
    expect(calls).toHaveLength(1);
    if (!value.ok) expect(value.definitive).toBeUndefined();
  });

  test("server terminal refusal is definitive", async () => {
    const { value } = await scenario([http(202, pending()), http(200, { status: "failed", details: { message: "Required check is expected." } })], 1_000);
    expect(value).toEqual({ ok: false, definitive: true, error: "Required check is expected." });
  });

  test("immediate refusal is definitive", async () => {
    const { value } = await scenario([http(400, { status: "failed", details: { message: "PR is closed" } })]);
    expect(value).toEqual({ ok: false, definitive: true, error: "PR is closed" });
  });

  test("poll deadline reports recovery command and never resubmits", async () => {
    const { value, calls } = await scenario([http(202, pending()), http(200, pending())], 60_000);
    expect(value.ok).toBe(false);
    if (!value.ok) {
      expect(value.retryable).toBe(false);
      expect(value.definitive).toBeUndefined();
      expect(value.error).toContain(`gh api repos/owner/repo/pulls/42/merge-async/${uuid}`);
    }
    expect(calls.filter((args) => args.includes("PUT"))).toHaveLength(1);
  });

  test.each([
    { stdout: "", stderr: "connection reset", exitCode: 1 },
    http(200, { status: "surprise", details: { message: "Unknown" } }),
    http(200, { status: "merged", details: { message: "Missing SHA" } }),
    http(200, { status: "enqueued" }),
    http(200, { status: "failed", details: { message: "Invalid submission HTTP status" } }),
  ])("unknown submission outcomes fail closed %j", async (result) => {
    const { value, calls } = await scenario([result]);
    expect(value.ok).toBe(false);
    if (!value.ok) expect(value.definitive).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test("failed poll preserves request UUID and cannot trigger another write", async () => {
    const { value, calls } = await scenario([http(202, pending()), http(404, { message: "Not found" })], 1_000);
    expect(value.ok).toBe(false);
    if (!value.ok) {
      expect(value.error).toContain(uuid);
      expect(value.definitive).toBeUndefined();
    }
    expect(calls).toHaveLength(2);
  });
});
