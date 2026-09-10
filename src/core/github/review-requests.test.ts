import { describe, expect, test } from "bun:test";

import { reviewRepositoryIsIgnored } from "./review-requests.ts";

describe("ignored review-request repositories", () => {
  const ignored = ["KoreSolutionsAI/prospect-pulse-box"];

  test("matches an exact owner/repository name case-insensitively", () => {
    expect(reviewRepositoryIsIgnored("KoreSolutionsAI/prospect-pulse-box", ignored)).toBe(true);
    expect(reviewRepositoryIsIgnored("koresolutionsai/PROSPECT-PULSE-BOX", ignored)).toBe(true);
  });

  test("does not hide another repository or a shared name prefix", () => {
    expect(reviewRepositoryIsIgnored("KoreSolutionsAI/prospect-pulse", ignored)).toBe(false);
    expect(reviewRepositoryIsIgnored("Elsewhere/prospect-pulse-box", ignored)).toBe(false);
    expect(reviewRepositoryIsIgnored(null, ignored)).toBe(false);
  });
});
