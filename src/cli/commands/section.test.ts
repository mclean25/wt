import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { run } from "./section.ts";

async function runQuiet(argv: string[]): Promise<number> {
  const error = console.error;
  console.error = (): void => {};
  try {
    return await Effect.runPromise(run(argv));
  } finally {
    console.error = error;
  }
}

describe("wt section option ownership", () => {
  for (const argv of [
    ["--only"],
    ["ls", "--only"],
    ["mv", "slug", "Section", "--json"],
    ["rename", "Old", "New", "--only"],
    ["rename", "Old", "New", "--json"],
    ["rm", "Section", "--only"],
    ["rm", "Section", "--json"],
  ]) {
    test(`rejects ${argv.join(" ")}`, async () => {
      expect(await runQuiet(argv)).toBe(2);
    });
  }
});
