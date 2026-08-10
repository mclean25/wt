/**
 * `--name` is the session's address, not decoration: peer Claude
 * instances list and message a session by it, and wt's registry
 * matchers (`cli/commands/{claude,fleet}.ts`) join on it. A regression
 * to a generic label makes every worktree indistinguishable to a peer,
 * which is silent — nothing in wt breaks, the fleet just stops being
 * addressable. Hence a test.
 */
import { describe, expect, test } from "bun:test";

import { claudeAgentAddress, claudeHarness } from "./harness.ts";

function nameArg(argv: string[]): string {
  const i = argv.indexOf("--name");
  expect(i).toBeGreaterThanOrEqual(0);
  return argv[i + 1]!;
}

describe("claudeHarness.buildArgs naming", () => {
  const base = { wtPath: "/tmp/wt-harness-test/eng-1-slug", resumeSessionId: null };

  test("a worktree primary is named after its slug", () => {
    const argv = claudeHarness.buildArgs({ ...base, slug: "eng-1-slug", managedName: null });
    expect(nameArg(argv)).toBe("eng-1-slug");
  });

  test("a named session carries the slug, so it stays unique across worktrees", () => {
    const argv = claudeHarness.buildArgs({ ...base, slug: "eng-1-slug", managedName: "review" });
    expect(nameArg(argv)).toBe("eng-1-slug~review");
  });

  test("an explicit label wins — slots would otherwise read as `manager~manager`", () => {
    const argv = claudeHarness.buildArgs({
      ...base,
      slug: "manager",
      managedName: "manager",
      displayLabel: "manager",
    });
    expect(nameArg(argv)).toBe("manager");
  });

  test("the name matches the tmux session name for the same identity", () => {
    for (const managedName of [null, "review"]) {
      const argv = claudeHarness.buildArgs({ ...base, slug: "eng-1-slug", managedName });
      expect(nameArg(argv)).toBe(claudeHarness.tmuxSessionName("eng-1-slug", managedName));
    }
  });
});

describe("claudeAgentAddress", () => {
  test("a session registered under the name wt gave it is addressable", () => {
    expect(claudeAgentAddress("eng-1-slug", "eng-1-slug")).toBe("eng-1-slug");
  });

  test("a pre-convention label is no address — it belongs to no worktree", () => {
    expect(claudeAgentAddress("primary", "eng-1-slug")).toBeNull();
  });

  test("no registered process, or one started outside wt, has no address", () => {
    expect(claudeAgentAddress(undefined, "eng-1-slug")).toBeNull();
    expect(claudeAgentAddress(null, "eng-1-slug")).toBeNull();
  });

  test("a session that shares a cwd doesn't borrow its neighbour's address", () => {
    expect(claudeAgentAddress("manager", "main")).toBeNull();
  });
});
