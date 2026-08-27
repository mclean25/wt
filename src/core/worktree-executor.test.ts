import { describe, expect, test } from "bun:test";

import {
  localWorktreeTarget,
  type WorktreeTarget,
} from "./worktree-target.ts";
import { decodeRemoteArgs } from "./remote-protocol.ts";
import { worktreeWtArgv } from "./worktree-executor.ts";

const common = {
  slug: "same-task",
  branch: "alex/same-task",
  path: "/worktrees/same-task",
  stage: "same-task",
};

describe("worktree executor", () => {
  test("ordinary wt operations have the same logical argv at either location", () => {
    const local = localWorktreeTarget(common);
    const remote: WorktreeTarget = {
      ...common,
      ref: { kind: "remote", host: "builder", slug: common.slug },
      location: {
        kind: "remote",
        endpoint: { host: "builder", label: "Builder", wtPath: "~/bin/wt" },
      },
    };
    const args = ["dev", "start", common.slug];
    expect(worktreeWtArgv(local, args).slice(-args.length)).toEqual(args);

    const encoded = worktreeWtArgv(remote, args)
      .at(-1)
      ?.match(/_remote ([A-Za-z0-9_-]+)$/)?.[1];
    expect(encoded).toBeDefined();
    expect(decodeRemoteArgs(encoded!)).toEqual(args);
  });
});
