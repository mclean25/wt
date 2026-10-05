import { describe, expect, test } from "bun:test";

import { canGenerateAutomatically } from "./ai.ts";

describe("automatic title generation", () => {
  test("preserves configured naming behavior without requiring a new config field", () => {
    expect(canGenerateAutomatically({})).toBe(true);
    expect(canGenerateAutomatically(null)).toBe(false);
  });

  test("a manual title disables automatic generation even with naming configured", () => {
    expect(canGenerateAutomatically({}, "My accepted title")).toBe(false);
    expect(canGenerateAutomatically(null, "My accepted title")).toBe(false);
  });
});
