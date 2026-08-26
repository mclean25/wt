import { describe, expect, test } from "bun:test";

import { buildSha, currentSourceSha, sameBuild } from "./build-id.ts";

describe("sameBuild", () => {
  const mine = buildSha();

  test("this repo answers with its own HEAD", () => {
    // The suite runs inside the wt checkout, so the null branch below is
    // the one that needs a fixture rather than this one.
    expect(currentSourceSha()).toMatch(/^[0-9a-f]{40}$/);
  });

  test("an artifact from this build is trusted", () => {
    expect(sameBuild(mine)).toBe(true);
  });

  test("an artifact from another build is not", () => {
    expect(sameBuild("0".repeat(40))).toBe(false);
  });

  test("an UNSTAMPED artifact is not trusted — only an older build writes one", () => {
    // The direction that matters. Absence here is the diagnosis, not a
    // missing input: every build that can stamp does, so a blank field
    // names a writer that predates the field.
    expect(sameBuild(undefined)).toBe(false);
    expect(sameBuild(null)).toBe(false);
    expect(sameBuild("")).toBe(false);
  });
});
