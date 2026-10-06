import { describe, expect, test } from "bun:test";

import { canGenerateAutomatically } from "./ai.ts";

describe("automatic title generation", () => {
  test("uses the automatic naming setting", () => {
    expect(canGenerateAutomatically({})).toBe(true);
    expect(canGenerateAutomatically(null)).toBe(false);
    expect(canGenerateAutomatically({ autoRename: false })).toBe(false);
    expect(canGenerateAutomatically({ autoRename: true })).toBe(true);
  });

  test("a manual title disables automatic generation even with naming configured", () => {
    expect(canGenerateAutomatically({}, "My accepted title")).toBe(false);
    expect(canGenerateAutomatically(null, "My accepted title")).toBe(false);
  });
});
