import { describe, expect, test } from "bun:test";

import { isSlashCommand } from "./session-messaging.ts";

describe("isSlashCommand", () => {
  test("matches a bare command", () => {
    expect(isSlashCommand("/compact")).toBe(true);
  });

  test("matches a command with arguments", () => {
    // The manager's `M m` payload: the command, then a paragraph of
    // focus instructions.
    expect(isSlashCommand("/compact Today is Wednesday. Preserve fleet state.")).toBe(true);
  });

  test("matches through leading whitespace", () => {
    expect(isSlashCommand("  /manager")).toBe(true);
  });

  test("matches a hyphenated command", () => {
    expect(isSlashCommand("/codex-review deep")).toBe(true);
  });

  // The reason the test is anchored+shaped rather than startsWith("/"):
  // an ordinary message must not be rerouted onto the pane transport.
  test("does not match an absolute path", () => {
    expect(isSlashCommand("/Users/michael/Code/thing.ts is where it broke")).toBe(false);
    expect(isSlashCommand("/tmp/foo.log has the trace")).toBe(false);
  });

  test("does not match prose that merely contains a command", () => {
    expect(isSlashCommand("Run /compact when the footer goes red")).toBe(false);
  });

  test("does not match a lone slash or an empty payload", () => {
    expect(isSlashCommand("/")).toBe(false);
    expect(isSlashCommand("")).toBe(false);
  });
});
