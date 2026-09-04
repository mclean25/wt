import { describe, expect, test } from "bun:test";

import { resolvePrimaryHarness } from "./primary.ts";

describe("resolvePrimaryHarness", () => {
  test("uses the configured default before a repository override exists", () => {
    expect(resolvePrimaryHarness({}, "codex")).toBe("codex");
  });

  test("keeps an intentional repository selection", () => {
    expect(resolvePrimaryHarness({ primary: "claude" }, "codex")).toBe("claude");
  });

  test("falls back when persisted state names an unknown harness", () => {
    expect(
      resolvePrimaryHarness(
        { primary: "gemini" as never },
        "codex",
      ),
    ).toBe("codex");
  });
});
