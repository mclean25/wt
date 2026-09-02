import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { run } from "./base.ts";

async function runQuiet(argv: string[]): Promise<number> {
  const error = console.error;
  console.error = (): void => {};
  try {
    return await Effect.runPromise(run(argv));
  } finally {
    console.error = error;
  }
}

describe("wt base arguments", () => {
  test("set rejects trailing arguments", async () => {
    expect(await runQuiet(["set", "slug", "parent", "extra"])).toBe(2);
  });

  test("clear rejects trailing arguments", async () => {
    expect(await runQuiet(["clear", "slug", "extra"])).toBe(2);
  });
});
