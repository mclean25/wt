import { expect, test } from "bun:test";
import { Effect } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { regenRulesync } from "./apply.ts";

test("regenRulesync records one failed root and continues in order", async () => {
  const missing = `wt-missing-rulesync-${process.pid}-${performance.now()}`;
  const results = await Effect.runPromise(regenRulesync([
    {
      root: process.cwd(),
      skillsDir: "",
      rootRuleFile: null,
      regen: [missing],
    },
    {
      root: process.cwd(),
      skillsDir: "",
      rootRuleFile: null,
      regen: ["sh", "-c", "printf regenerated"],
    },
  ]));

  expect(results).toHaveLength(2);
  expect(results[0]?.ok).toBeFalse();
  // A failed root never reaches the uncommitted-file count.
  expect(results[0]?.uncommitted).toBeNull();
  expect(results[1]?.root).toBe(process.cwd());
  expect(results[1]?.ok).toBeTrue();
  expect(results[1]?.output).toBe("regenerated");
  // The wt checkout is a git repo, so the count is a number (whatever
  // the working tree happens to hold), never unknown.
  expect(typeof results[1]?.uncommitted).toBe("number");
});

test("regenRulesync reports an unknown uncommitted count outside a git repo", async () => {
  const outside = mkdtempSync(join(tmpdir(), "wt-regen-nogit-"));
  try {
    const results = await Effect.runPromise(regenRulesync([
      { root: outside, skillsDir: "", rootRuleFile: null, regen: ["sh", "-c", "printf ok"] },
    ]));
    expect(results[0]?.ok).toBeTrue();
    expect(results[0]?.uncommitted).toBeNull();
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
