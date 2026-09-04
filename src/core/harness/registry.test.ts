import { describe, expect, test } from "bun:test";

import { visibleHarnesses } from "./registry.ts";

describe("visibleHarnesses", () => {
  const harnesses = [
    { id: "claude" as const },
    { id: "codex" as const },
    { id: "opencode" as const },
  ];

  test("keeps registry order while removing personal hidden harnesses", () => {
    expect(
      visibleHarnesses(harnesses, new Set(["opencode"])).map((h) => h.id),
    ).toEqual(["claude", "codex"]);
  });

  test("shows every supported harness by default", () => {
    expect(visibleHarnesses(harnesses, new Set()).map((h) => h.id)).toEqual([
      "claude",
      "codex",
      "opencode",
    ]);
  });
});
