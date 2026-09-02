import { describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";

import { run } from "./_dev-giveup.ts";

describe("wt _dev-giveup arguments", () => {
  test("rejects trailing arguments before cleanup", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await Effect.runPromise(run(["slug", "extra"]))).toBe(2);
      expect(error).toHaveBeenCalledWith("usage: wt _dev-giveup <slug>");
    } finally {
      error.mockRestore();
    }
  });
});
