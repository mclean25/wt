import { describe, expect, test } from "bun:test";

import { destroyLogSlug } from "./logs.ts";

describe("destroyLogSlug", () => {
  test("splits the slug from the iso stamp, slug hyphens and all", () => {
    expect(destroyLogSlug("coz-1691-domestic-bovid-2026-08-17T15-04-05-123Z.log")).toBe(
      "coz-1691-domestic-bovid",
    );
  });

  // The whole reason this is a stamp-anchored parse rather than a
  // `startsWith(`${slug}-`)` test. Worktrees derived from one issue lead
  // with the same id, so a shorter slug is a live prefix of a longer one,
  // and `-` is legal inside both.
  test("does not claim a longer slug's log for its prefix", () => {
    const name = "coz-1691-domestic-bovid-2026-08-17T15-04-05-123Z.log";
    expect(name.startsWith("coz-1691-")).toBe(true); // the old, wrong test
    expect(destroyLogSlug(name)).not.toBe("coz-1691");
  });

  test("rejects names that aren't destroy logs", () => {
    expect(destroyLogSlug("update.log")).toBeNull();
    expect(destroyLogSlug("coz-1691-domestic-bovid.log")).toBeNull();
    expect(destroyLogSlug("coz-1691-2026-08-17T15-04-05-123Z.txt")).toBeNull();
  });
});
