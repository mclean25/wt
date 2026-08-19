import { describe, expect, test } from "bun:test";

import { buildQuery, chunkBranches, isTransientFailure } from "./fetch.ts";

const res = (over: Partial<{ stdout: string; stderr: string; exitCode: number }> = {}) => ({
  stdout: "",
  stderr: "",
  exitCode: 1,
  ...over,
});

/**
 * The classifier decides whether a failed round trip is worth a retry.
 * Both directions are expensive to get wrong: a permanent failure
 * retried is two wasted round trips and, for a rate limit, actively
 * makes the situation worse — while a transient failure NOT retried is
 * the badge blanking that motivated the whole change.
 *
 * Every "transient" string below is a verbatim `gh` failure captured
 * from a real fleet on one day, when a 35-branch query sat on GitHub's
 * server-side execution ceiling. They are five costumes for one event.
 */
describe("isTransientFailure", () => {
  test("classifies every observed timeout costume as retryable", () => {
    const observed = [
      "gh: HTTP 502",
      "gh: HTTP 504",
      "stream error: stream ID 1; CANCEL; received from peer",
      "gh: We couldn't respond to your request in time. Sorry about that. Please try resubmitting your request and contact us if the problem persists.",
      "unexpected end of JSON input",
      "gh: No server is currently available to service your request. Sorry about that. (HTTP 503)",
    ];
    for (const stderr of observed) {
      expect(isTransientFailure(res({ stderr }))).toBe(true);
    }
  });

  test("treats our own SIGKILL timeout as retryable", () => {
    // `run` surfaces a timeout as a negative exit code with nothing
    // captured, so there is no message to pattern-match on.
    expect(isTransientFailure(res({ exitCode: -1 }))).toBe(true);
  });

  test("never retries a rate limit", () => {
    // The load-bearing case: retrying is what escalates a brush with
    // the limit into a block.
    expect(isTransientFailure(res({ stderr: "API rate limit exceeded for user" }))).toBe(false);
    expect(
      isTransientFailure(res({ stdout: '{"errors":[{"type":"RATE_LIMITED"}]}' })),
    ).toBe(false);
    expect(
      isTransientFailure(res({ stderr: "You have exceeded a secondary rate limit" })),
    ).toBe(false);
  });

  test("a rate limit reported alongside a 5xx is still not retried", () => {
    // Permanent patterns are tested first precisely so a body carrying
    // both can't be read as retryable.
    expect(
      isTransientFailure(res({ stderr: "gh: HTTP 503", stdout: "API rate limit exceeded" })),
    ).toBe(false);
  });

  test("does not retry permanent failures", () => {
    expect(isTransientFailure(res({ stderr: "gh: Bad credentials (HTTP 401)" }))).toBe(false);
    expect(
      isTransientFailure(res({ stderr: "Could not resolve to a Repository with the name" })),
    ).toBe(false);
    expect(isTransientFailure(res({ stderr: 'Expected NAME, actual: LCURLY ("{")' }))).toBe(false);
    expect(isTransientFailure(res({ stderr: "gh: HTTP 404" }))).toBe(false);
  });
});

describe("chunkBranches", () => {
  const b = (n: number) => Array.from({ length: n }, (_, i) => `branch-${i}`);

  test("splits without dropping or duplicating a branch", () => {
    for (const n of [1, 7, 8, 9, 24, 35, 100]) {
      const groups = chunkBranches(b(n), 8);
      expect(groups.flat()).toEqual(b(n));
      expect(groups.every((g) => g.length > 0 && g.length <= 8)).toBe(true);
    }
  });

  test("an exact multiple produces no empty trailing chunk", () => {
    expect(chunkBranches(b(16), 8)).toHaveLength(2);
  });

  test("no branches means no chunks, so no round trip", () => {
    expect(chunkBranches([], 8)).toEqual([]);
  });
});

describe("buildQuery", () => {
  test("declares one variable and one alias per branch", () => {
    const q = buildQuery(3, false);
    for (const i of [0, 1, 2]) {
      expect(q).toContain(`$b${i}: String!`);
      expect(q).toContain(`wt_${i}: pullRequests(`);
    }
    expect(q).not.toContain("wt_3");
  });

  test("carries the merge queue only when asked", () => {
    // Repo-wide data: refetching it per chunk would multiply it by the
    // chunk count for one usable copy.
    expect(buildQuery(3, true)).toContain("mergeQueue");
    expect(buildQuery(3, false)).not.toContain("mergeQueue");
  });

  test("always ships the fragment the aliases reference", () => {
    for (const withMq of [true, false]) {
      const q = buildQuery(2, withMq);
      expect(q).toContain("fragment PrFields on PullRequest");
      expect(q).toContain("...PrFields");
    }
  });
});
