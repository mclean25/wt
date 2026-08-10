import { describe, expect, test } from "bun:test";

import type { PrComment } from "../../core/types.ts";
import {
  commentLines,
  latestForeignAt,
  newCommentsSince,
} from "./usePrCommentEvents.ts";

const c = (author: string, createdAt: string, body = "hi"): PrComment => ({
  author,
  body,
  createdAt,
});

// The github source hands comments over newest-first.
const CONVERSATION: PrComment[] = [
  c("me", "2026-08-10T21:20:18Z", "/codex-review"),
  c("alex", "2026-08-10T21:08:29Z", "I put the dark mode in for meetings chat"),
  c("me", "2026-08-10T20:50:00Z", "opening this up"),
];

describe("newCommentsSince", () => {
  test("returns other people's comments after the mark, oldest-first", () => {
    const fresh = newCommentsSince(CONVERSATION, "2026-08-10T20:00:00Z", "me");
    expect(fresh.map((x) => x.createdAt)).toEqual(["2026-08-10T21:08:29Z"]);
  });

  test("an empty mark (PR had no comments when seeded) counts everything", () => {
    expect(newCommentsSince(CONVERSATION, "", "me")).toHaveLength(1);
  });

  test("your own comments never count, however new", () => {
    expect(newCommentsSince(CONVERSATION, "2026-08-10T21:08:29Z", "me")).toEqual([]);
  });

  test("already-narrated comments don't repeat", () => {
    expect(newCommentsSince(CONVERSATION, "2026-08-10T21:08:29Z", "someone-else")).toHaveLength(1);
  });
});

describe("latestForeignAt", () => {
  test("ignores your own newer comment so the mark stays where it was", () => {
    expect(latestForeignAt(CONVERSATION, "me")).toBe("2026-08-10T21:08:29Z");
  });

  test("no foreign comments seeds an empty mark", () => {
    expect(latestForeignAt([c("me", "2026-08-10T21:20:18Z")], "me")).toBe("");
  });
});

describe("commentLines", () => {
  test("one line per comment, body flattened", () => {
    expect(commentLines([c("alex", "2026-08-10T21:08:29Z", "line one\n\nline two")])).toEqual([
      "alex commented: line one line two",
    ]);
  });

  test("truncates a long body", () => {
    const [line] = commentLines([c("alex", "2026-08-10T21:08:29Z", "x".repeat(400))]);
    expect(line!.length).toBeLessThan(140);
    expect(line!.endsWith("…")).toBe(true);
  });

  test("collapses a backlog into one summary line", () => {
    const many = ["01", "02", "03", "04"].map((n, i) =>
      c(i < 2 ? "alex" : "sam", `2026-08-10T21:${n}:00Z`),
    );
    expect(commentLines(many)).toEqual(["4 new PR comments (alex, sam)"]);
  });

  test("nothing new says nothing", () => {
    expect(commentLines([])).toEqual([]);
  });
});
