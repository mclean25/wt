import { describe, expect, test } from "bun:test";

import { neutralSendArgs } from "./claude.ts";

describe("legacy claude send", () => {
  test("delegates to neutral routing instead of forcing Claude", () => {
    expect(neutralSendArgs("wt", ["hello"])).toEqual(["send", "wt", "hello"]);
    expect(neutralSendArgs("manager", ["/compact"])).toEqual([
      "send",
      "manager",
      "/compact",
    ]);
  });
});
