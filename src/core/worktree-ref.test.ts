import { describe, expect, test } from "bun:test";

import {
  isRemoteWorktreeLedgerKey,
  remoteWorktreeLedgerKey,
  remoteWorktreeLedgerPrefix,
  worktreeLedgerKey,
} from "./worktree-ref.ts";

describe("worktree ledger identity", () => {
  test("keeps local slugs backward-compatible", () => {
    expect(worktreeLedgerKey({ kind: "local", slug: "eng-123-fix" })).toBe(
      "eng-123-fix",
    );
  });

  test("distinguishes the same slug on different remote hosts", () => {
    const first = remoteWorktreeLedgerKey("builder-a", "eng-123-fix");
    const second = remoteWorktreeLedgerKey("builder-b", "eng-123-fix");

    expect(first).not.toBe(second);
    expect(first.startsWith(remoteWorktreeLedgerPrefix("builder-a"))).toBe(true);
    expect(isRemoteWorktreeLedgerKey(first)).toBe(true);
    expect(isRemoteWorktreeLedgerKey("eng-123-fix")).toBe(false);
  });

  test("encodes host and slug delimiters without collisions", () => {
    expect(remoteWorktreeLedgerKey("host/a", "feature/x")).not.toBe(
      remoteWorktreeLedgerKey("host", "a/feature/x"),
    );
  });
});
