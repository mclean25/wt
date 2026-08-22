/**
 * The merge-queue refusal classifier. Every `enqueuePullRequest`
 * failure comes back as GraphQL type `UNPROCESSABLE` with prose, so
 * "this PR isn't ready YET" and "this call is wrong" are the same error
 * code and only the message separates them — which is why this has to
 * fail closed. A false positive arms a DIFFERENT GitHub feature than
 * the one the keystroke asked for.
 */
import { describe, expect, test } from "bun:test";

import { checksStillPending, notYetEnqueueable } from "./mutations.ts";

describe("notYetEnqueueable", () => {
  // Observed verbatim on a live queue base while a required check had
  // not yet reported (wt app log, 2026-08-21).
  test("a queue refusing an unready PR is retryable as classic arming", () => {
    expect(
      notYetEnqueueable(
        "gh: Pull request 2 of 4 required status checks have not succeeded: 1 expected.",
      ),
    ).toBe(true);
  });

  test("other unprocessable refusals are not", () => {
    // Also observed live: a stale cached head oid. Arming classic
    // auto-merge here would merge a commit the user never saw.
    expect(
      notYetEnqueueable(
        "gh: Failed to add PR #1411: expected head oid does not match the current head oid",
      ),
    ).toBe(false);
    expect(notYetEnqueueable("gh: Could not resolve to a node with the global id of ''")).toBe(
      false,
    );
    expect(notYetEnqueueable("gh: Pull request is already queued")).toBe(false);
  });

  // Absence of a value means unknown, never "fine".
  test("a missing or empty error is not a retry signal", () => {
    expect(notYetEnqueueable(undefined)).toBe(false);
    expect(notYetEnqueueable("")).toBe(false);
  });
});

describe("checksStillPending", () => {
  // Verbatim from the refusal that produced this: wt armed at
  // 23:55:21Z and the workflow created "Unit tests (Vitest)" at
  // 23:56:23Z, 62 seconds later.
  const REAL = 'gh: Pull request Required status check "Unit tests (Vitest)" is expected.';
  // Verbatim from PR #1424, the SAME check name minutes later in its
  // life. This one refuted the belief that a queue takes a PR whose
  // required checks are merely running.
  const RUNNING =
    'gh: Pull request Required status check "Unit tests (Vitest)" is in progress.';

  test("recognises a required check that has not reported at all", () => {
    expect(checksStillPending(REAL)).toBe(true);
  });

  test("recognises a required check that is still running", () => {
    expect(checksStillPending(RUNNING)).toBe(true);
  });

  test("does NOT claim a merely-unsuccessful check", () => {
    // The aggregate wording mixes pending with failed, so it cannot say
    // whether waiting helps — and an ambiguous message must fail closed.
    // Verified against a live PR: six required checks IN_PROGRESS and
    // mergeStateStatus BLOCKED still enqueued, so "have not succeeded"
    // is a different situation and must not be called retryable.
    expect(
      checksStillPending(
        "Pull request 2 of 4 required status checks have not succeeded: 1 expected.",
      ),
    ).toBe(false);
  });

  test("a check that FAILED is never retryable — someone has to re-run it", () => {
    expect(
      checksStillPending('Pull request Required status check "Unit tests (Vitest)" has failed.'),
    ).toBe(false);
  });

  test("does not fire on the wrong-commit refusal", () => {
    expect(
      checksStillPending("expected head oid does not match the current head oid"),
    ).toBe(false);
  });

  test("absent and unrecognised messages are not retryable", () => {
    expect(checksStillPending(undefined)).toBe(false);
    expect(checksStillPending("Auto merge is not allowed for this repository")).toBe(false);
  });

  test("pending is a subset of not-yet-enqueueable, so ordering is what separates them", () => {
    // Both match the real messages; `enableAutoMerge` therefore has to
    // test the narrower one FIRST or the retryable flag is never set.
    for (const msg of [REAL, RUNNING]) {
      expect(notYetEnqueueable(msg)).toBe(true);
      expect(checksStillPending(msg)).toBe(true);
    }
  });
});
