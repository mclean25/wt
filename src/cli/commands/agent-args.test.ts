import { describe, expect, test } from "bun:test";

import { parseAgentArgs, skillPrompt } from "./agent-args.ts";

describe("parseAgentArgs", () => {
  test("parses send and preserves free text", () => {
    expect(parseAgentArgs(["send", "wt", "continue", "carefully"])).toEqual({
      kind: "send",
      target: "wt",
      textArgs: ["continue", "carefully"],
    });
    expect(parseAgentArgs(["send", "main"])).toEqual({
      kind: "send",
      target: "main",
      textArgs: [],
    });
  });

  test("parses neutral inventory", () => {
    expect(parseAgentArgs(["ls"])).toEqual({ kind: "list", json: false });
    expect(parseAgentArgs(["ls", "--json"])).toEqual({ kind: "list", json: true });
    expect(parseAgentArgs(["ls", "extra"])).toMatchObject({ kind: "error" });
  });

  test("start is one worktree and no extra arguments", () => {
    expect(parseAgentArgs(["start", "eng-1-fix"])).toEqual({ kind: "start", target: "eng-1-fix" });
    expect(parseAgentArgs(["start", "eng-1-fix", "extra"])).toMatchObject({ kind: "error" });
  });

  test("rejects explicit harness selection instead of forcing a stale choice", () => {
    expect(parseAgentArgs(["send", "wt", "--harness", "claude", "go"])).toEqual({
      kind: "error",
      message: "--harness was removed; wt routes to the target's active harness automatically",
    });
    expect(parseAgentArgs(["--harness=codex", "start", "eng-1-fix"])).toMatchObject({ kind: "error" });
  });
});

describe("skillPrompt", () => {
  test("uses the receiving harness's native skill prefix", () => {
    expect(skillPrompt("/", "start")).toBe("/start");
    expect(skillPrompt("$", "start")).toBe("$start");
  });
});
