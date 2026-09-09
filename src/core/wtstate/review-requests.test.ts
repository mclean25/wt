import { expect, test } from "bun:test";

import { addReviewRequestDismissal } from "./review-requests.ts";

test("replaces an older dismissal for the same PR", () => {
  expect(addReviewRequestDismissal(
    [{ url: "https://github.com/o/r/pull/1", updatedAt: "old", dismissedAt: "then" }],
    { url: "https://github.com/o/r/pull/1", updatedAt: "new", dismissedAt: "now" },
  )).toEqual([
    { url: "https://github.com/o/r/pull/1", updatedAt: "new", dismissedAt: "now" },
  ]);
});

test("bounds the dismissal ledger", () => {
  const existing = Array.from({ length: 200 }, (_, index) => ({
    url: `https://github.com/o/r/pull/${index}`,
    updatedAt: `${index}`,
    dismissedAt: `${index}`,
  }));
  const result = addReviewRequestDismissal(existing, {
    url: "https://github.com/o/r/pull/new",
    updatedAt: "new",
    dismissedAt: "now",
  });
  expect(result).toHaveLength(200);
  expect(result[0]?.url).toBe("https://github.com/o/r/pull/1");
  expect(result.at(-1)?.url).toBe("https://github.com/o/r/pull/new");
});
