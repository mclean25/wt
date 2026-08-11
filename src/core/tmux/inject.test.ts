import { expect, test } from "bun:test";

import { injectIntoSession } from "./inject.ts";

test("Claude can never fall back to terminal input", async () => {
  const result = await injectIntoSession({
    slug: "worktree",
    cwd: "/tmp/worktree",
    harnessId: "claude" as never,
    text: "must not be typed",
  });

  expect(result).toEqual({
    ok: false,
    reason: "Claude terminal messaging is disabled; use claudeSessions.send",
  });
});
