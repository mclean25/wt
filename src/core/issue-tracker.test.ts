import { describe, expect, test } from "bun:test";

import { issueIdForSlug, repoWebUrl } from "./issue-tracker.ts";

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

  test("gh-prefixed ids parse like any other", () => {
    expect(issueIdForSlug("gh-970-fix-typo")).toBe("GH-970");
  });
});

describe("repoWebUrl", () => {
  test("scp-style ssh remote", () => {
    expect(repoWebUrl("git@github.com:TransitivIO/cozee-dev.git")).toBe(
      "https://github.com/TransitivIO/cozee-dev",
    );
  });

  test("https remote, with and without .git", () => {
    expect(repoWebUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r");
    expect(repoWebUrl("https://github.com/o/r")).toBe("https://github.com/o/r");
  });

  test("ssh:// remote", () => {
    expect(repoWebUrl("ssh://git@github.com/o/r.git")).toBe("https://github.com/o/r");
  });

  test("null for bare ssh-config host aliases (no real hostname)", () => {
    expect(repoWebUrl("github-personal:micthiesen/wt.git")).toBeNull();
  });
});
