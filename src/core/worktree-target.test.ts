import { describe, expect, test } from "bun:test";

import {
  isRemoteWorktreeTarget,
  localWorktreeTarget,
  remoteWorktreeTarget,
  worktreeActionKey,
  worktreeTargetKey,
} from "./worktree-target.ts";

describe("worktree targets", () => {
  test("local and remote rows expose the same common metadata", () => {
    const common = {
      slug: "eng-123-fix",
      branch: "alex/eng-123-fix",
      path: "/worktrees/eng-123-fix",
      stage: "alex-eng-123-fix",
    };
    const local = localWorktreeTarget(common);
    const remote = remoteWorktreeTarget({
      ...common,
      remote: { host: "builder-a", label: "Builder A", wtPath: "~/bin/wt" },
    });

    expect(local).toMatchObject(common);
    expect(remote).toMatchObject(common);
    expect(isRemoteWorktreeTarget(local)).toBe(false);
    expect(isRemoteWorktreeTarget(remote)).toBe(true);
  });

  test("remote identity is endpoint-qualified", () => {
    const row = {
      slug: "same-slug",
      branch: "alex/same-slug",
      path: "/worktrees/same-slug",
      stage: "alex-same-slug",
    };
    const a = remoteWorktreeTarget({
      ...row,
      remote: { host: "builder-a", label: "A", wtPath: "~/bin/wt" },
    });
    const b = remoteWorktreeTarget({
      ...row,
      remote: { host: "builder-b", label: "B", wtPath: "~/bin/wt" },
    });

    expect(worktreeTargetKey(a)).not.toBe(worktreeTargetKey(b));
    expect(worktreeActionKey(a)).not.toBe(worktreeActionKey(b));
    expect(worktreeActionKey(a)).not.toBe(a.slug);
    expect(worktreeActionKey(localWorktreeTarget(row))).toBe(row.slug);
  });
});
