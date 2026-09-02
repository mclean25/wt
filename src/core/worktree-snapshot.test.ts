/**
 * `parseWorkerSnapshot` decodes untrusted JSON off an SSH worker's stdout
 * (see `docs/backends.md` for the remote worker protocol). It's the one
 * Schema use in the codebase, replacing ~150 lines of hand-rolled field
 * validation — this pins the accepted shape and the malformed-payload
 * behavior the Schema conversion must preserve.
 */
import { expect, test } from "bun:test";

import { StatusKind, type Status } from "./types.ts";
import { WORKER_PROTOCOL_VERSION } from "./worker-info.ts";
import { parseWorkerSnapshot, type WorkerSnapshot } from "./worktree-snapshot.ts";

function validRow() {
  return {
    slug: "coz-1234-widget",
    branch: "test/coz-1234-widget",
    base: "staging",
    path: "/wt/coz-1234-widget",
    stage: "coz-1234-widget",
    deployed: false,
    exists: true,
    status: { kind: StatusKind.Clean, label: "clean" } as Status,
    dev: {
      running: false,
      starting: false,
      crashed: false,
      port: null,
      url: null,
      since: null,
      waiting: null,
      rebasedSince: null,
      restarts: null,
    },
    dirty: false,
    unpushed: 0,
    pushed: true,
    aheadOfBase: 0,
    issueId: "COZ-1234",
    issueUrl: "https://example.test/COZ-1234",
    githubIssue: null,
    githubIssueUrl: null,
    work: null,
  };
}

function payload(overrides: Partial<ReturnType<typeof validRow>> = {}, protocol = WORKER_PROTOCOL_VERSION) {
  return JSON.stringify({
    protocol,
    worktrees: [{ ...validRow(), ...overrides }],
  });
}

test("round-trips a well-formed snapshot", () => {
  const result: WorkerSnapshot = parseWorkerSnapshot(payload());
  expect(result.protocol).toBe(WORKER_PROTOCOL_VERSION);
  expect(result.worktrees).toHaveLength(1);
  expect(result.worktrees[0]).toMatchObject({
    slug: "coz-1234-widget",
    status: { kind: StatusKind.Clean, label: "clean" },
    work: null,
  });
});

test("accepts a status row with optional fields present", () => {
  const result = parseWorkerSnapshot(payload({
    status: { kind: StatusKind.Busy, label: "busy", age: "3m", pid: 123, op: "restack" },
  }));
  expect(result.worktrees[0]!.status).toEqual({ kind: StatusKind.Busy, label: "busy", age: "3m", pid: 123, op: "restack" });
});

test("recovers the JSON object from surrounding login-shell noise", () => {
  const raw = `Last login: Tue\nmotd banner\n${payload()}\n`;
  const result = parseWorkerSnapshot(raw);
  expect(result.worktrees).toHaveLength(1);
});

test("rejects non-JSON output with a useful diagnostic", () => {
  expect(() => parseWorkerSnapshot("bash: wt: command not found")).toThrow(/did not return JSON/);
});

test("rejects a protocol mismatch by name, before validating shape", () => {
  expect(() => parseWorkerSnapshot(payload({}, 1))).toThrow(/uses protocol 1; expected/);
});

test("rejects a missing protocol field", () => {
  const raw = JSON.stringify({ worktrees: [validRow()] });
  expect(() => parseWorkerSnapshot(raw)).toThrow(/uses protocol undefined; expected/);
});

test("rejects a malformed row with a field-pathed error", () => {
  // `dev.running` wrong type — Schema decode failure, not a silent drop.
  const raw = payload({ dev: { ...validRow().dev, running: "yes" as unknown as boolean } });
  expect(() => parseWorkerSnapshot(raw)).toThrow();
});

test("rejects a status.kind outside the known vocabulary", () => {
  const raw = payload({ status: { kind: "exploded", label: "?" } as unknown as ReturnType<typeof validRow>["status"] });
  expect(() => parseWorkerSnapshot(raw)).toThrow();
});

test("rejects worktrees that isn't an array", () => {
  const raw = JSON.stringify({ protocol: WORKER_PROTOCOL_VERSION, worktrees: {} });
  expect(() => parseWorkerSnapshot(raw)).toThrow();
});

test("rejects a work record whose state is unrecognized", () => {
  // `parseWorkStatus` folds an unrecognized/garbage `work` value to
  // `null`; a non-null raw value that fails to parse is still an error
  // here (distinguishes "no record" from "a broken one").
  const raw = payload({ work: { state: "not-a-real-state", at: "2026-01-01T00:00:00Z" } as never });
  expect(() => parseWorkerSnapshot(raw)).toThrow(/\.work is invalid/);
});
