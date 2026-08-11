import { describe, expect, test } from "bun:test";

import { claudeHarness } from "./harness.ts";

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

  test("every wt-managed process registers its native inbox", () => {
    const argv = claudeHarness.buildArgs({ ...base, slug: "eng-1-slug", managedName: null });
    const settingsIndex = argv.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThanOrEqual(0);
    const settings = JSON.parse(argv[settingsIndex + 1]!) as {
      crossSessionInbound?: string;
      hooks?: { SessionStart?: Array<{ hooks?: Array<{ command?: string }> }> };
    };

    expect(settings.crossSessionInbound).toBe("accept");
    expect(settings.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toContain(
      "_claude-hook register",
    );
  });
});
