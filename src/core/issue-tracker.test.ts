import { describe, expect, test } from "bun:test";

import { issueIdForSlug } from "./issue-tracker.ts";

describe("issueIdForSlug", () => {
  test("extracts and uppercases an id at the head of a slug", () => {
    expect(issueIdForSlug("coz-1883-some-fix")).toBe("COZ-1883");
    expect(issueIdForSlug("eng-4959-restack-engine")).toBe("ENG-4959");
  });

  test("matches an id embedded mid-slug (foreign branch layouts)", () => {
    expect(issueIdForSlug("worktree-david+eng-4959-thing")).toBe("ENG-4959");
  });

  test("bare id with no trailing slug", () => {
    expect(issueIdForSlug("coz-1883")).toBe("COZ-1883");
  });

  test("null for slugs without an id", () => {
    expect(issueIdForSlug("quick-spike")).toBeNull();
    expect(issueIdForSlug("")).toBeNull();
  });
});
