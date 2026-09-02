import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { run } from "./edge.ts";

describe("wt edge arguments", () => {
  test("a bare -m is an argument error", async () => {
    const error = console.error;
    console.error = (): void => {};
    try {
      expect(await Effect.runPromise(run(["-m"]))).toBe(2);
    } finally {
      console.error = error;
    }
  });
});
