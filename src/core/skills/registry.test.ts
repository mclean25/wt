import { describe, expect, test } from "bun:test";

import { findUnit, UNITS, unitSource } from "./registry.ts";

describe("bundled skills registry", () => {
  test("every declared unit has a readable bundled source", () => {
    for (const unit of UNITS) {
      expect(unitSource(unit), unit.name).not.toBeNull();
    }
  });

  test("handoff is a distributed skill", () => {
    expect(findUnit("handoff")).toMatchObject({
      kind: "skill",
      name: "handoff",
    });
  });
});
