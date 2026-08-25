import { describe, expect, test } from "bun:test";

import { devLogLines } from "./dev-logs-overlay.tsx";

describe("devLogLines", () => {
  test("scrubs terminal control noise without dropping blank rows", () => {
    expect(devLogLines("\u001b[31merror\u001b[0m\n\nnext\x07")).toEqual([
      "error",
      "",
      "next",
    ]);
  });

  test("keeps the full bounded snapshot for overlay scrolling", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    expect(devLogLines(lines)).toHaveLength(200);
    expect(devLogLines(lines).at(-1)).toBe("line 199");
  });
});
