import { describe, expect, test } from "bun:test";

import { countUntickedBoxes } from "./parse.ts";

// Pins the checklist-counting rules against the real summary-comment
// shapes a checklist-mode review bot emits (see docs/configuration.md
// `[review_bot]`): column-0 checkboxes, ticked boxes, indented plain
// sub-bullets, and fenced suggestion blocks that quote checkbox syntax.
describe("countUntickedBoxes", () => {
  test("counts unticked boxes and ignores ticked ones", () => {
    const body = [
      "### 🤖 Codex review",
      "",
      "#### Issues (3) — check off as you accept or dismiss each:",
      "- [ ] **🔴 High** First issue — `a.ts:10`",
      "- [x] **🟠 Medium** Accepted issue — `b.ts:20`",
      "- [ ] **🟡 Low** Third issue — `c.ts:30`",
    ].join("\n");
    expect(countUntickedBoxes(body)).toBe(2);
  });

  test("clean review with no checkboxes counts zero", () => {
    expect(
      countUntickedBoxes("### 🤖 Codex review\n\n#### Issues\nNo material issues found. ✅"),
    ).toBe(0);
  });

  test("ignores checkbox syntax quoted inside fenced code blocks", () => {
    const body = [
      "- [ ] **🟠 Medium** Fix the checklist template",
      "  - _Fix:_ update the template",
      "",
      "  ```",
      "  - [ ] this is example text inside a suggestion block",
      "  - [ ] so is this",
      "  ```",
    ].join("\n");
    expect(countUntickedBoxes(body)).toBe(1);
  });

  test("counts indented (nested) checkboxes outside fences — GitHub renders them as real boxes", () => {
    const body = ["- [ ] parent item", "  - [ ] nested sub-item"].join("\n");
    expect(countUntickedBoxes(body)).toBe(2);
  });
});
