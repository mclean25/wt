import { describe, expect, spyOn, test } from "bun:test";
import { Effect } from "effect";

import { run } from "./fleet.ts";

describe("wt fleet arguments", () => {
  test("rejects trailing positional arguments before doing I/O", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await Effect.runPromise(run(["extra"]))).toBe(2);
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("unexpected argument: extra"),
      );
    } finally {
      error.mockRestore();
    }
  });
});
