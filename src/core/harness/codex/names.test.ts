import { describe, expect, test } from "bun:test";

import { assignCodexNames } from "./names.ts";

describe("assignCodexNames", () => {
  test("assigns stable primary and numeric names in discovery order", () => {
    expect(assignCodexNames({}, ["newest", "older"]).names).toEqual({
      newest: "primary",
      older: "2",
    });
  });

  test("preserves canonical mappings when discovery order changes", () => {
    expect(
      assignCodexNames(
        { primaryId: "primary", secondId: "2" },
        ["secondId", "primaryId", "thirdId"],
      ),
    ).toEqual({
      names: { primaryId: "primary", secondId: "2", thirdId: "3" },
      changed: true,
    });
  });

  test("repairs zero, duplicate, and stale mappings", () => {
    expect(
      assignCodexNames(
        {
          zero: "0",
          first: "primary",
          duplicate: "primary",
          stale: "2",
        },
        ["zero", "first", "duplicate"],
      ),
    ).toEqual({
      names: { first: "primary", zero: "2", duplicate: "3" },
      changed: true,
    });
  });

  test("releases primary when its old session is outside discovery", () => {
    expect(
      assignCodexNames(
        { expired: "primary", visible: "2" },
        ["visible"],
      ),
    ).toEqual({ names: { visible: "primary" }, changed: true });
  });
});
