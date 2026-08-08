import { describe, expect, test } from "bun:test";

import { parseStatusArgs } from "./status.ts";

/**
 * The flag/positional/validation matrix for `wt status`, pinned
 * against the pure parser. The rules here are what make agent
 * assertions trustworthy — regressions would silently let an
 * unqualified `ready` or a note-less `needs-human` through, or
 * swallow flags (`-m --clear`) without an error.
 */
describe("parseStatusArgs", () => {
  test("bare invocation shows the cwd worktree", () => {
    expect(parseStatusArgs([])).toEqual({ kind: "show", slugArg: null });
  });

  test("single state positional sets on cwd; prefixes and aliases resolve", () => {
    expect(parseStatusArgs(["working"])).toMatchObject({
      kind: "set",
      slugArg: null,
      state: "working",
    });
    expect(parseStatusArgs(["nt", "-m", "check the email copy"])).toMatchObject({
      kind: "set",
      state: "needs-testing",
      note: "check the email copy",
    });
  });

  test("slug + state form targets the slug", () => {
    expect(parseStatusArgs(["some-slug", "todo"])).toMatchObject({
      kind: "set",
      slugArg: "some-slug",
      state: "todo",
    });
  });

  test("non-state positional is a show target", () => {
    expect(parseStatusArgs(["some-slug"])).toEqual({
      kind: "show",
      slugArg: "some-slug",
    });
  });

  test("ambiguous prefixes error consistently in both positional forms", () => {
    const one = parseStatusArgs(["r"]);
    const two = parseStatusArgs(["some-slug", "r"]);
    expect(one).toMatchObject({ kind: "error" });
    expect(two).toMatchObject({ kind: "error" });
    for (const r of [one, two]) {
      expect((r as { message: string }).message).toContain("ambiguous");
      expect((r as { message: string }).message).toContain("review");
      expect((r as { message: string }).message).toContain("ready");
    }
  });

  test("flags never swallow a following flag as their value", () => {
    expect(parseStatusArgs(["working", "-m", "--clear"])).toMatchObject({
      kind: "error",
    });
    expect(parseStatusArgs(["ready", "--risk"])).toMatchObject({ kind: "error" });
  });

  test("--all rejects combinations that would silently drop intent", () => {
    expect(parseStatusArgs(["--all"])).toEqual({ kind: "all", json: false });
    expect(parseStatusArgs(["--all", "--json"])).toEqual({ kind: "all", json: true });
    expect(parseStatusArgs(["--all", "--clear"])).toMatchObject({ kind: "error" });
    expect(parseStatusArgs(["--all", "some-slug"])).toMatchObject({ kind: "error" });
    expect(parseStatusArgs(["--json"])).toMatchObject({ kind: "error" });
  });

  test("--clear takes an optional slug and nothing else", () => {
    expect(parseStatusArgs(["--clear"])).toEqual({ kind: "clear", slugArg: null });
    expect(parseStatusArgs(["--clear", "a-slug"])).toEqual({
      kind: "clear",
      slugArg: "a-slug",
    });
    expect(parseStatusArgs(["--clear", "-m", "x"])).toMatchObject({ kind: "error" });
  });

  test("ready requires risk; medium/high require a note; low doesn't", () => {
    expect(parseStatusArgs(["ready"])).toMatchObject({ kind: "error" });
    expect(parseStatusArgs(["ready", "--risk", "medium"])).toMatchObject({
      kind: "error",
    });
    expect(parseStatusArgs(["ready", "--risk", "low"])).toMatchObject({
      kind: "set",
      state: "ready",
      risk: "low",
      note: null,
    });
    expect(
      parseStatusArgs(["ready", "--risk", "high", "-m", "not reasonably testable"]),
    ).toMatchObject({ kind: "set", risk: "high", note: "not reasonably testable" });
  });

  test("risk only applies to ready; needs-human requires a note", () => {
    expect(parseStatusArgs(["working", "--risk", "low"])).toMatchObject({
      kind: "error",
    });
    expect(parseStatusArgs(["needs-human"])).toMatchObject({ kind: "error" });
    expect(parseStatusArgs(["nh", "-m", "log me in"])).toMatchObject({
      kind: "set",
      state: "needs-human",
    });
  });

  test("whitespace-only notes count as absent", () => {
    expect(parseStatusArgs(["needs-human", "-m", "   "])).toMatchObject({
      kind: "error",
    });
  });

  test("-m / --risk without a state to set is an error", () => {
    expect(parseStatusArgs(["-m", "note only"])).toMatchObject({ kind: "error" });
  });

  test("help and unknown flags", () => {
    expect(parseStatusArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseStatusArgs(["-x"])).toMatchObject({ kind: "error" });
    expect(parseStatusArgs(["a", "b", "c"])).toMatchObject({ kind: "error" });
  });
});
