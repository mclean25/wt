import { describe, expect, test } from "bun:test";

import { newDevServerCrashes } from "./useDevServerEvents.ts";

const row = (slug: string, crashed: boolean, archived = false) => ({
  key: slug,
  slug,
  archived,
  dev: { crashed },
});

describe("newDevServerCrashes", () => {
  test("seeding records state without reporting an existing crash", () => {
    const seen = new Map<string, boolean>();
    expect(newDevServerCrashes([row("old", true), row("live", false)], seen)).toEqual([]);
    expect(seen).toEqual(new Map([["old", true], ["live", false]]));
  });

  test("reports each healthy-to-crashed transition once and resets after recovery", () => {
    const seen = new Map<string, boolean>([["task", false]]);
    expect(newDevServerCrashes([row("task", true)], seen)).toEqual(["task"]);
    expect(newDevServerCrashes([row("task", true)], seen)).toEqual([]);
    expect(newDevServerCrashes([row("task", false)], seen)).toEqual([]);
    expect(newDevServerCrashes([row("task", true)], seen)).toEqual(["task"]);
  });

  test("ignores archived rows and forgets rows that leave the live list", () => {
    const seen = new Map<string, boolean>([["gone", false], ["archived", false]]);
    expect(newDevServerCrashes([row("archived", true, true)], seen)).toEqual([]);
    expect(seen.size).toBe(0);
  });
});
