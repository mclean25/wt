import { describe, expect, test } from "bun:test";

import {
  type ChecklistBot,
  countUntickedBoxes,
  hasMarker,
  rollupChecklist,
  rollupChecks,
} from "./parse.ts";

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

/**
 * `rollupChecklist` decides the review-bot glyph for a checklist bot.
 * Every case here is built from PR #1444, where a delta review posted
 * one open finding and the badge stayed green.
 *
 * The bot is injected rather than read from `[review_bot]`, so these run
 * the same on a machine configured for a checklist bot and in CI, whose
 * synthetic config has no `[review_bot]` at all. Inheriting it would
 * make the suite vacuous in exactly the place it is asked to vouch for.
 */
describe("rollupChecklist", () => {
  const FULL = "### 🤖 Codex review";
  const DELTA = "### 🤖 Codex follow-up reviews";
  const ACK = "🤖 ⏳ Codex review started";
  const BOT: ChecklistBot = {
    login: "github-actions",
    summaryMarkers: [FULL, DELTA],
    pendingMarker: ACK,
  };
  const HEAD = "2026-08-24T17:24:26Z";
  // #1444's head. Deliberately absent from every fixture body below, so
  // only the test that plants it exercises the bot's own coverage claim.
  const HEAD_OID = "7947de21fce23771511e0ef2db9d7379aec3ed6a";

  const comment = (
    body: string,
    createdAt: string,
    updatedAt?: string,
  ): { author: { login: string }; body: string; createdAt: string; updatedAt?: string } => ({
    author: { login: "github-actions" },
    body,
    createdAt,
    updatedAt: updatedAt ?? createdAt,
  });
  const nodes = (...cs: ReturnType<typeof comment>[]) => ({ nodes: cs }) as never;
  const botRun = (status: string, conclusion: string | null) =>
    [{ __typename: "CheckRun" as const, name: "Codex code review", status, conclusion }] as never;

  // The exact pair on #1444: the full pass had both its boxes ticked,
  // and the delta log posted afterwards carried one open item.
  const CLOSED_FULL = `${FULL}\n\n#### Issues (2)\n- [x] a\n- [x] b\n`;
  const OPEN_DELTA = `${DELTA}\n\n#### \`8e7fe82\`\n\n#### Issues (1)\n- [ ] Bound the Twilio compensation request\n`;

  test("counts an open finding in a SECOND checklist the bot keeps", () => {
    // The bug. One marker saw one of two live checklists, and the one it
    // saw was the empty one — so the glyph read green with a Medium
    // finding open. Latest-of-all would have been just as wrong in the
    // other direction once the full pass has items and the delta does not.
    const rb = rollupChecklist(
      botRun("COMPLETED", "SUCCESS"),
      nodes(
        comment(CLOSED_FULL, "2026-08-24T17:01:17Z", "2026-08-24T17:19:08Z"),
        comment(OPEN_DELTA, "2026-08-24T17:21:06Z", "2026-08-24T17:25:54Z"),
      ),
      HEAD,
      HEAD_OID,
      BOT,
    );
    expect(rb).toEqual({ state: "unresolved", unresolved: 1, stale: false });
  });

  test("sums across checklists rather than letting the newest win", () => {
    const rb = rollupChecklist(
      null,
      nodes(
        comment(`${FULL}\n- [ ] one\n- [ ] two\n`, "2026-08-24T17:01:17Z"),
        comment(`${DELTA}\n- [ ] three\n`, "2026-08-24T17:21:06Z"),
      ),
      null,
      HEAD_OID,
      BOT,
    );
    expect(rb.unresolved).toBe(3);
  });

  test("a fresh full pass supersedes the previous one, per marker", () => {
    const rb = rollupChecklist(
      null,
      nodes(
        comment(`${FULL}\n- [ ] stale finding\n`, "2026-08-24T15:00:00Z"),
        comment(`${FULL}\n- [x] fixed\n`, "2026-08-24T17:01:17Z"),
      ),
      null,
      HEAD_OID,
      BOT,
    );
    expect(rb).toEqual({ state: "clean", unresolved: 0, stale: false });
  });

  test("the bot's own check on the head answers staleness outright", () => {
    // #1444's delta log was CREATED before the head commit existed and
    // appended to afterwards, so the timestamp proxy called a review of
    // the head stale. The bot's check run hangs off the head commit, so
    // its presence is the direct answer the proxy was standing in for.
    const comments = nodes(comment(CLOSED_FULL, "2026-08-24T17:01:17Z"));
    expect(rollupChecklist(botRun("COMPLETED", "SUCCESS"), comments, HEAD, HEAD_OID, BOT).stale).toBe(false);
    expect(rollupChecklist(null, comments, HEAD, HEAD_OID, BOT).stale).toBe(true);
  });

  test("a clean review of an older commit stays flagged stale", () => {
    // The reviewer that never re-runs on push: no bot context on the
    // head at all, so the proxy is all there is and must still fire.
    const rb = rollupChecklist(
      null,
      nodes(comment(CLOSED_FULL, "2026-08-24T17:01:17Z")),
      HEAD,
      HEAD_OID,
      BOT,
    );
    expect(rb).toEqual({ state: "clean", unresolved: 0, stale: true });
  });

  test("a running bot check reads pending", () => {
    const rb = rollupChecklist(
      botRun("IN_PROGRESS", null),
      nodes(comment(CLOSED_FULL, "2026-08-24T17:01:17Z")),
      HEAD,
      HEAD_OID,
      BOT,
    );
    expect(rb.state).toBe("pending");
  });

  test("an ack newer than every summary reads pending", () => {
    const rb = rollupChecklist(
      null,
      nodes(
        comment(CLOSED_FULL, "2026-08-24T17:01:17Z"),
        comment(`${ACK}\n`, "2026-08-24T17:30:00Z"),
      ),
      HEAD,
      HEAD_OID,
      BOT,
    );
    expect(rb.state).toBe("pending");
  });

  test("an ack that PRECEDES its own summary is not a re-run", () => {
    const rb = rollupChecklist(
      null,
      nodes(
        comment(`${ACK}\n`, "2026-08-24T16:57:44Z"),
        comment(CLOSED_FULL, "2026-08-24T17:01:17Z"),
      ),
      HEAD,
      HEAD_OID,
      BOT,
    );
    expect(rb.state).toBe("clean");
  });

  test("open findings outrank a re-run in progress", () => {
    // A push re-triggers the bot routinely; the open items are still
    // what needs addressing, and a spinner would hide them.
    const rb = rollupChecklist(
      botRun("IN_PROGRESS", null),
      nodes(comment(OPEN_DELTA, "2026-08-24T17:21:06Z")),
      HEAD,
      HEAD_OID,
      BOT,
    );
    expect(rb).toEqual({ state: "unresolved", unresolved: 1, stale: false });
  });

  test("the LONGEST matching marker claims a comment", () => {
    // Markers are prefixes and one can contain another. First-match
    // would file both headings under one key and silently keep only the
    // newer, which is the same drop this whole change exists to stop.
    const nested: ChecklistBot = {
      login: "github-actions",
      summaryMarkers: ["### Review", "### Review follow-up"],
      pendingMarker: null,
    };
    const rb = rollupChecklist(
      null,
      nodes(
        comment("### Review\n- [ ] one\n", "2026-08-24T17:00:00Z"),
        comment("### Review follow-up\n- [ ] two\n", "2026-08-24T17:10:00Z"),
      ),
      null,
      HEAD_OID,
      nested,
    );
    expect(rb.unresolved).toBe(2);
  });

  test("no summary at all is `none`, not a clean bill of health", () => {
    expect(
      rollupChecklist(null, nodes(comment("unrelated", "2026-08-24T17:00:00Z")), HEAD, HEAD_OID, BOT).state,
    ).toBe("none");
  });

  test("a comment from someone else never counts", () => {
    const nodesFromHuman = {
      nodes: [{ author: { login: "michael" }, body: OPEN_DELTA, createdAt: HEAD, updatedAt: HEAD }],
    } as never;
    expect(rollupChecklist(null, nodesFromHuman, HEAD, HEAD_OID, BOT).state).toBe("none");
  });
});

/**
 * The bot's own coverage stamp, which outranks every proxy wt can build
 * for it. Verbatim shapes from PR #1446's follow-up comment.
 */
describe("rollupChecklist — the sha the bot stamps", () => {
  const DELTA = "### 🤖 Codex follow-up reviews";
  const BOT: ChecklistBot = {
    login: "github-actions",
    summaryMarkers: [DELTA],
    pendingMarker: null,
  };
  const OID = "28daaa283855d75773598f5affe9b29926f75ff6";
  const PUSHED_AT = "2026-08-24T17:52:37Z";
  const REVIEWED_AT = "2026-08-24T17:36:17Z";

  const body = (covered: string) =>
    `${DELTA}\n\n#### \`${covered.slice(0, 7)}\`\nNo material issues found. ✅\n` +
    `<!-- codex-review-state:v1 {"version":1,"head":"${covered}"} -->\n`;
  const nodes = (b: string) =>
    ({
      nodes: [
        { author: { login: "github-actions" }, body: b, createdAt: REVIEWED_AT, updatedAt: REVIEWED_AT },
      ],
    }) as never;

  test("naming the head clears staleness before any check registers", () => {
    // The window that produced a yellow badge on a PR whose delta review
    // had already come back clean: the comment names the head minutes
    // before the workflow attaches its check runs to it, and until then
    // the check-context proxy has nothing to say. The comment does.
    const rb = rollupChecklist(null, nodes(body(OID)), PUSHED_AT, OID, BOT);
    expect(rb).toEqual({ state: "clean", unresolved: 0, stale: false });
  });

  test("naming a DIFFERENT commit leaves it stale", () => {
    const rb = rollupChecklist(
      null,
      nodes(body("575fe8ef9554003d36452a9bb7334f3369933846")),
      PUSHED_AT,
      OID,
      BOT,
    );
    expect(rb.stale).toBe(true);
  });

  test("a bot that never mentions a sha falls back to the older proxies", () => {
    // The signal is positive-only: absence must change nothing, or every
    // reviewer that does not stamp shas becomes permanently stale.
    const plain = `${DELTA}\n\nNo material issues found. ✅\n`;
    expect(rollupChecklist(null, nodes(plain), PUSHED_AT, OID, BOT).stale).toBe(true);
    expect(rollupChecklist(null, nodes(plain), null, OID, BOT).stale).toBe(false);
  });

  test("an absent or truncated head oid is not a coverage claim", () => {
    expect(rollupChecklist(null, nodes(body(OID)), PUSHED_AT, null, BOT).stale).toBe(true);
    expect(rollupChecklist(null, nodes(body(OID)), PUSHED_AT, "28da", BOT).stale).toBe(true);
  });
});
