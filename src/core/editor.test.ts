/**
 * `renderEditorCommand` builds the string handed to `$SHELL -lc`, so a
 * worktree path with a space (or a quote) that isn't escaped becomes
 * two arguments — the editor opens the wrong directory, or nothing.
 * Worktree paths come from the user's `worktree_root`, which wt never
 * sanitizes, so this is reachable rather than theoretical.
 */
import { describe, expect, test } from "bun:test";

import { renderEditorCommand } from "./editor.ts";

describe("renderEditorCommand", () => {
  test("substitutes {{path}}", () => {
    expect(renderEditorCommand("cursor {{path}}", "/w/eng-1")).toBe("cursor '/w/eng-1'");
  });

  test("substitutes every occurrence", () => {
    expect(renderEditorCommand("cd {{path}} && code {{path}}", "/w/a")).toBe(
      "cd '/w/a' && code '/w/a'",
    );
  });

  test("appends the path when the command doesn't mention it", () => {
    // A bare editor name is what people will actually type first.
    expect(renderEditorCommand("code -n", "/w/eng-1")).toBe("code -n '/w/eng-1'");
  });

  test("quotes a path with spaces", () => {
    expect(renderEditorCommand("zed {{path}}", "/My Code/eng 1")).toBe("zed '/My Code/eng 1'");
  });

  test("escapes a single quote so the argument can't break out", () => {
    expect(renderEditorCommand("zed {{path}}", "/w/it's")).toBe(`zed '/w/it'\\''s'`);
  });

  test("leaves the rest of the command untouched, pipes and all", () => {
    expect(renderEditorCommand("open -a Cursor {{path}} >/dev/null 2>&1", "/w/a")).toBe(
      "open -a Cursor '/w/a' >/dev/null 2>&1",
    );
  });
});
