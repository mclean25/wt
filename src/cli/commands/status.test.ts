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

  test("dropped requires a note and takes no risk", () => {
    expect(parseStatusArgs(["dropped"])).toMatchObject({ kind: "error" });
    expect(parseStatusArgs(["dropped", "--risk", "low", "-m", "dupe"])).toMatchObject({
      kind: "error",
    });
    expect(
      parseStatusArgs(["d", "-m", "duplicate of COZ-2050 — #1091 merged"]),
    ).toMatchObject({
      kind: "set",
      state: "dropped",
      note: "duplicate of COZ-2050 — #1091 merged",
    });
  });

  test("whitespace-only notes count as absent", () => {
    expect(parseStatusArgs(["needs-human", "-m", "   "])).toMatchObject({
      kind: "error",
    });
  });

  test("-m without a state points at --note-only instead of guessing", () => {
    const r = parseStatusArgs(["-m", "note only"]);
    expect(r).toMatchObject({ kind: "error" });
    expect((r as { message: string }).message).toContain("--note-only");
  });

  test("--risk without a state amends an existing record", () => {
    // Risk is a confidence call that moves as testing lands; re-asserting
    // `ready` in full to change it fakes a fresh assertion and forces the
    // note to be restated.
    expect(parseStatusArgs(["--risk", "low"])).toEqual({
      kind: "amend",
      slugArg: null,
      note: null,
      risk: "low",
      append: false,
    });
    expect(parseStatusArgs(["some-slug", "--risk", "hi"])).toEqual({
      kind: "amend",
      slugArg: "some-slug",
      note: null,
      risk: "high",
      append: false,
    });
    expect(parseStatusArgs(["--risk", "medium", "-m", "backfill never ran"])).toEqual({
      kind: "amend",
      slugArg: null,
      note: "backfill never ran",
      risk: "medium",
      append: false,
    });
  });

  test("--note-only amends the note alone", () => {
    expect(parseStatusArgs(["--note-only", "sharper ask"])).toEqual({
      kind: "amend",
      slugArg: null,
      note: "sharper ask",
      risk: null,
      append: false,
    });
    expect(parseStatusArgs(["--note-only", "x", "--risk", "low"])).toMatchObject({
      kind: "error",
    });
    expect(parseStatusArgs(["--note-only", "x", "ready"])).toMatchObject({
      kind: "error",
    });
  });

  test("help and unknown flags", () => {
    expect(parseStatusArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseStatusArgs(["-x"])).toMatchObject({ kind: "error" });
    expect(parseStatusArgs(["a", "b", "c"])).toMatchObject({ kind: "error" });
  });
});

describe("parseStatusArgs --blocked-on / --unblock", () => {
  const parse = (s: string) => parseStatusArgs(s.split("|"));

  test("decorates a ready assertion", () => {
    const a = parse('ready|--risk|low|--blocked-on|mobile 2.14 shipped');
    expect(a).toMatchObject({
      kind: "set",
      state: "ready",
      risk: "low",
      blockedOn: "mobile 2.14 shipped",
    });
  });

  // The gate means "finished but must not merge yet", so it only has a
  // meaning where merging was otherwise on the table. Anywhere else it
  // would be a second, weaker way of saying what the state already says.
  test("is refused on every state but ready", () => {
    for (const state of ["working", "review", "needs-testing", "needs-human", "todo", "dropped"]) {
      const a = parse(`${state}|-m|n|--blocked-on|a release`);
      expect(a.kind).toBe("error");
    }
  });

  test("with no state it amends in place, so the gate can clear without re-asserting", () => {
    expect(parse("--unblock")).toMatchObject({ kind: "amend", blockedOn: null });
    expect(parse("--blocked-on|a release")).toMatchObject({
      kind: "amend",
      blockedOn: "a release",
    });
  });

  // Amending is how a gate clears WITHOUT minting a new `at` — which is
  // what keeps the suppressed `status.ready` automation fire live, and
  // keeps the note from being reset by a branch that only wanted to say
  // "the world moved".
  test("an amend carries no state, so nothing is re-asserted", () => {
    const a = parse("--unblock");
    expect(a).not.toHaveProperty("state");
  });

  test("setting and clearing at once is refused", () => {
    expect(parse("--blocked-on|x|--unblock").kind).toBe("error");
  });

  // A fresh assertion replaces the whole record, gate included, so
  // asking for both is a sign the writer expects one of them not to
  // happen.
  test("--unblock alongside a state is refused rather than silently redundant", () => {
    expect(parse("ready|--risk|low|--unblock").kind).toBe("error");
  });

  test("an empty gate is refused, not silently treated as unblocking", () => {
    expect(parseStatusArgs(["ready", "--risk", "low", "--blocked-on", "   "]).kind).toBe(
      "error",
    );
  });

  test("does not combine with --all/--clear/--note-only", () => {
    expect(parse("--all|--unblock").kind).toBe("error");
    expect(parse("--clear|--blocked-on|x").kind).toBe("error");
    expect(parse("--note-only|n|--unblock").kind).toBe("error");
  });

  test("a plain ready carries no gate", () => {
    expect(parse("ready|--risk|low")).toMatchObject({ kind: "set", blockedOn: null });
  });
});
