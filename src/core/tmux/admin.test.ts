import { describe, expect, test } from "bun:test";

import {
  classifySessions,
  closeHarnessUsesPaneInput,
  orphanedSessions,
} from "./admin.ts";
import { parseSessionHarnessIds, tmuxServerDefinitelyAbsent } from "./process.ts";

describe("closeHarnessUsesPaneInput", () => {
  test("hard-kills Claude without typing into its pane", () => {
    expect(closeHarnessUsesPaneInput("claude")).toBe(false);
  });

  test("preserves graceful pane input for other harnesses", () => {
    expect(closeHarnessUsesPaneInput("codex")).toBe(true);
    expect(closeHarnessUsesPaneInput("opencode")).toBe(true);
  });
});

describe("classifySessions", () => {
  test("partitions raw session names by kind", () => {
    const result = classifySessions([
      "eng-1234-foo",
      "eng-1234-foo~scratch",
      "eng-5678-bar-codex",
      "eng-5678-bar-opencode",
      "eng-9999-baz-diff",
      "eng-9999-baz-shell",
      "eng-1111-qux-action",
    ]);
    expect(result.claude).toEqual([
      { slug: "eng-1234-foo", name: null },
      { slug: "eng-1234-foo", name: "scratch" },
    ]);
    expect(result.claudeSlugs).toEqual(new Set(["eng-1234-foo"]));
    expect(result.codex).toEqual(new Set(["eng-5678-bar"]));
    expect(result.opencode).toEqual(new Set(["eng-5678-bar"]));
    expect(result.diff).toEqual(new Set(["eng-9999-baz"]));
    expect(result.shell).toEqual(new Set(["eng-9999-baz"]));
    expect(result.action).toEqual(new Set(["eng-1111-qux"]));
  });
});

describe("orphanedSessions", () => {
  test("reaps dead-slug sessions of every kind", () => {
    const live = new Set(["eng-1234-foo"]);
    const orphans = orphanedSessions(
      [
        "eng-1234-foo", // live slug — kept
        "eng-1234-foo-diff", // live slug, diff kind — kept
        "eng-9999-gone", // dead slug — reaped
        "eng-9999-gone-shell", // dead slug, shell kind — reaped
      ],
      live,
    );
    expect(orphans).toEqual(["eng-9999-gone", "eng-9999-gone-shell"]);
  });
});

test("tmux harness UUID metadata preserves unstamped sessions", () => {
  const parsed = parseSessionHarnessIds([
    "demo-codex\tthread-2",
    "demo-shell\t",
    "legacy-session",
  ].join("\n"));

  expect(parsed.all).toEqual(new Set(["demo-codex", "demo-shell", "legacy-session"]));
  expect(parsed.harnessSessionIds).toEqual(new Map([["demo-codex", "thread-2"]]));
});

test("only a definitely absent tmux server is an honest empty inventory", () => {
  expect(tmuxServerDefinitelyAbsent("no server running on /tmp/tmux/wt")).toBe(true);
  expect(tmuxServerDefinitelyAbsent(
    "error connecting to /tmp/tmux/wt (No such file or directory)",
  )).toBe(true);
  expect(tmuxServerDefinitelyAbsent(
    "error connecting to /tmp/tmux/wt (Permission denied)",
  )).toBe(false);
});
