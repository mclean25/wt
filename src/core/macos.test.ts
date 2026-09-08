import { describe, expect, test } from "bun:test";

import { openUrlCommand } from "./macos.ts";

describe("openUrlCommand", () => {
  test.each([
    "https://github.com/acme/repo/pull/1",
    "http://localhost:8105",
    "linear://review/123",
  ])("opens %s through Launch Services without profile flags", (url) => {
    expect(openUrlCommand(url)).toEqual(["open", url]);
  });
});
