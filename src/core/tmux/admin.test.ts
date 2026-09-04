import { describe, expect, test } from "bun:test";

import {
  classifySessions,
  closeHarnessUsesPaneInput,
  orphanedSessions,
} from "./admin.ts";

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
