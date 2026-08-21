/**
 * The merge-queue refusal classifier. Every `enqueuePullRequest`
 * failure comes back as GraphQL type `UNPROCESSABLE` with prose, so
 * "this PR isn't ready YET" and "this call is wrong" are the same error
 * code and only the message separates them — which is why this has to
 * fail closed. A false positive arms a DIFFERENT GitHub feature than
 * the one the keystroke asked for.
 */
import { describe, expect, test } from "bun:test";

import { notYetEnqueueable } from "./mutations.ts";

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
