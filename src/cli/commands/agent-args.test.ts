import { describe, expect, test } from "bun:test";

import { parseAgentArgs, skillPrompt } from "./agent-args.ts";

describe("parseAgentArgs", () => {
  test("parses send text without interpreting it", () => {
    expect(parseAgentArgs(["send", "eng-1-fix", "continue", "carefully"])).toEqual({
      kind: "send",
      target: "eng-1-fix",
      textArgs: ["continue", "carefully"],
      harness: null,
    });
  });

  test("allows send with no text so stdin can supply it", () => {
    expect(parseAgentArgs(["send", "eng-1-fix"])).toEqual({
      kind: "send",
      target: "eng-1-fix",
      textArgs: [],
      harness: null,
    });
  });

  test("start is one worktree and no extra arguments", () => {
    expect(parseAgentArgs(["start", "eng-1-fix"])).toEqual({
      kind: "start",
      target: "eng-1-fix",
      harness: null,
    });
    expect(parseAgentArgs(["start", "eng-1-fix", "extra"])).toMatchObject({ kind: "error" });
  });

  test("rejects missing and unknown subcommands", () => {
    expect(parseAgentArgs([])).toMatchObject({ kind: "error" });
    expect(parseAgentArgs(["launch", "eng-1-fix"])).toMatchObject({ kind: "error" });
  });

  test("--harness addresses one explicitly and leaves the text alone", () => {
    // The gap this closes: a caller who could SEE the right session in
    // `tmux list-sessions` had no supported way to reach it.
    expect(parseAgentArgs(["send", "eng-1-fix", "--harness", "codex", "go", "now"])).toEqual({
      kind: "send",
      target: "eng-1-fix",
      textArgs: ["go", "now"],
      harness: "codex",
    });
    expect(parseAgentArgs(["--harness=codex", "start", "eng-1-fix"])).toEqual({
      kind: "start",
      target: "eng-1-fix",
      harness: "codex",
    });
  });

  test("a bad or missing --harness value is an error, never a silent default", () => {
    // Falling back here would reintroduce the exact failure: a message
    // delivered confidently to the wrong harness.
    expect(parseAgentArgs(["send", "eng-1-fix", "--harness", "gemini"])).toMatchObject({
      kind: "error",
    });
    expect(parseAgentArgs(["send", "eng-1-fix", "--harness"])).toMatchObject({ kind: "error" });
  });

  test("text that looks like the flag's value is still text", () => {
    const parsed = parseAgentArgs(["send", "eng-1-fix", "use", "codex", "for", "this"]);
    expect(parsed).toMatchObject({ harness: null, textArgs: ["use", "codex", "for", "this"] });
  });
});

describe("skillPrompt", () => {
  test("uses the receiving harness's native skill prefix", () => {
    expect(skillPrompt("/", "start")).toBe("/start");
    expect(skillPrompt("$", "start")).toBe("$start");
  });
});
