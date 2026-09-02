import { expect, test } from "bun:test";
import { Effect } from "effect";

import { actionRegistry } from "./registry.ts";

test("synchronous metadata updates do not leave completed fibers tracked", async () => {
  const registry = actionRegistry as unknown as {
    persistMetaUpdatePromise(runDir: string, patch: Record<string, unknown>): void;
    pendingMetaWrites: Set<unknown>;
  };
  const baseline = registry.pendingMetaWrites.size;

  for (let index = 0; index < 100; index++) {
    registry.persistMetaUpdatePromise(
      `/definitely/missing/wt-action-meta-${process.pid}-${index}`,
      { status: "failed" },
    );
  }
  await Effect.runPromise(Effect.yieldNow);

  expect(registry.pendingMetaWrites.size).toBe(baseline);
});
