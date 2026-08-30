import { describe, expect, test } from "bun:test";

import { openUrlCommand } from "./macos.ts";

describe("openUrlCommand", () => {
  test("uses the default browser without a configured Chrome profile", () => {
    expect(openUrlCommand("https://github.com/acme/repo/pull/1", null)).toEqual([
      "open",
      "https://github.com/acme/repo/pull/1",
    ]);
  });

  test("opens web links in the configured Chrome profile", () => {
    expect(openUrlCommand("https://github.com/acme/repo/pull/1", "Profile 3"))
      .toEqual([
        "open",
        "-a",
        "Google Chrome",
        "--args",
        "--profile-directory=Profile 3",
        "--ignore-profile-directory-if-not-exists",
        "https://github.com/acme/repo/pull/1",
      ]);
  });

  test("leaves custom URL schemes with Launch Services", () => {
    expect(openUrlCommand("linear://review/123", "Profile 3")).toEqual([
      "open",
      "linear://review/123",
    ]);
  });
});
