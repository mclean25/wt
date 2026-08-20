import { describe, expect, test } from "bun:test";

import { countUntickedBoxes, hasMarker, rollupChecks } from "./parse.ts";

/**
 * `hasMarker` decides which of a PR's comments IS the review bot's
 * summary. Get it wrong in one direction and the badge is blank with
 * nothing to debug; wrong in the other and a human quoting the heading
 * hijacks the unresolved count. Two variants of the same reviewer
 * workflow, in two repos, differ on exactly the case pinned first.
 */
describe("hasMarker", () => {
  const SUMMARY = "### 🤖 Codex review";
  const HTML = "<!-- codex-review-summary -->";

  test("matches a marker at the very start", () => {
    expect(hasMarker(`${SUMMARY}\n\n#### What changed\n...`, SUMMARY)).toBe(true);
  });

  test("matches past a leading machine-readable HTML comment", () => {
    // The shape that a strict prefix test rejected.
    expect(hasMarker(`${HTML}\n${SUMMARY}\n\nbody`, SUMMARY)).toBe(true);
    expect(hasMarker(`${HTML}\n${SUMMARY}\n\nbody`, HTML)).toBe(true);
  });

  test("matches through leading indentation on the marker's line", () => {
    expect(hasMarker(`${HTML}\n  ${SUMMARY}\n`, SUMMARY)).toBe(true);
  });

  test("does not match a heading quoted below the scan window", () => {
    const body = ["intro", "more", "padding", SUMMARY, "quoted above"].join("\n");
    expect(hasMarker(body, SUMMARY)).toBe(false);
  });

  test("does not match a marker mid-line", () => {
    expect(hasMarker(`see the ${SUMMARY} comment`, SUMMARY)).toBe(false);
  });

  test("an empty body matches nothing", () => {
    expect(hasMarker("", SUMMARY)).toBe(false);
  });
});

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


/**
 * `statusCheckRollup` is history: GitHub keeps every check run recorded
 * against a head sha, so a re-run leaves the failed original beside the
 * green retry under the same context name.
 */
describe("rollupChecks superseded-run dedupe", () => {
  const run = (name: string, conclusion: string, startedAt?: string) => ({
    __typename: "CheckRun" as const,
    name,
    status: "COMPLETED",
    conclusion,
    ...(startedAt ? { startedAt } : {}),
  });

  test("a green re-run supersedes the failure it replaced", () => {
    // The reported case: a job failed while the PR was a draft, was
    // re-run green on the same sha, and the badge stayed red forever on
    // a PR whose mergeStateStatus was CLEAN.
    expect(
      rollupChecks([
        run("Codex review complete", "FAILURE", "2026-08-20T10:00:00Z"),
        run("Codex review complete", "SUCCESS", "2026-08-20T11:00:00Z"),
      ]),
    ).toBe("pass");
  });

  test("order in the array does not decide it — the timestamp does", () => {
    expect(
      rollupChecks([
        run("build", "SUCCESS", "2026-08-20T11:00:00Z"),
        run("build", "FAILURE", "2026-08-20T10:00:00Z"),
      ]),
    ).toBe("pass");
  });

  test("a genuinely newer failure still fails", () => {
    // The dedupe must not become a way to lose real red.
    expect(
      rollupChecks([
        run("build", "SUCCESS", "2026-08-20T10:00:00Z"),
        run("build", "FAILURE", "2026-08-20T11:00:00Z"),
      ]),
    ).toBe("fail");
  });

  test("different contexts are never collapsed into each other", () => {
    expect(
      rollupChecks([
        run("lint", "SUCCESS", "2026-08-20T11:00:00Z"),
        run("build", "FAILURE", "2026-08-20T10:00:00Z"),
      ]),
    ).toBe("fail");
  });

  test("undated entries keep the old any-failure-counts behaviour", () => {
    // A pre-v19 persisted entry carries no startedAt. Unknown ordering
    // must fail toward red: a false red costs a look, a false green is
    // a broken branch reported as fine.
    expect(rollupChecks([run("build", "FAILURE"), run("build", "SUCCESS")])).toBe("fail");
  });

  test("a pending re-run of a failed context reads as pending", () => {
    expect(
      rollupChecks([
        run("build", "FAILURE", "2026-08-20T10:00:00Z"),
        {
          __typename: "CheckRun" as const,
          name: "build",
          status: "IN_PROGRESS",
          conclusion: null,
          startedAt: "2026-08-20T11:00:00Z",
        },
      ]),
    ).toBe("pending");
  });
});
