import { describe, expect, test } from "bun:test";

import { parseAgentArgs, skillPrompt } from "./agent-args.ts";

describe("parseAgentArgs", () => {
  test("parses send text without interpreting it", () => {
    expect(parseAgentArgs(["send", "eng-1-fix", "continue", "carefully"])).toEqual({
      kind: "send",
      target: "eng-1-fix",
      textArgs: ["continue", "carefully"],
    });
  });

  test("allows send with no text so stdin can supply it", () => {
    expect(parseAgentArgs(["send", "eng-1-fix"])).toEqual({
      kind: "send",
      target: "eng-1-fix",
      textArgs: [],
    });
  });

  test("start is one worktree and no extra arguments", () => {
    expect(parseAgentArgs(["start", "eng-1-fix"])).toEqual({
      kind: "start",
      target: "eng-1-fix",
    });
    expect(parseAgentArgs(["start", "eng-1-fix", "extra"])).toMatchObject({ kind: "error" });
  });

  test("rejects missing and unknown subcommands", () => {
    expect(parseAgentArgs([])).toMatchObject({ kind: "error" });
    expect(parseAgentArgs(["launch", "eng-1-fix"])).toMatchObject({ kind: "error" });
  });
});

describe("skillPrompt", () => {
  test("uses the receiving harness's native skill prefix", () => {
    expect(skillPrompt("/", "start")).toBe("/start");
    expect(skillPrompt("$", "start")).toBe("$start");
  });
});
