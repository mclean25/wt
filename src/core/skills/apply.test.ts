import { expect, test } from "bun:test";
import { Effect } from "effect";

import { regenRulesyncEffect } from "./apply.ts";

test("regenRulesyncEffect records one failed root and continues in order", async () => {
  const missing = `wt-missing-rulesync-${process.pid}-${performance.now()}`;
  const results = await Effect.runPromise(regenRulesyncEffect([
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
  expect(results[1]).toEqual({
    root: process.cwd(),
    ok: true,
    output: "regenerated",
  });
});
