/**
 * The PR glyph's armed colour. "Merge when ready" is two GitHub
 * features wearing one label and only one of them sets `autoMerge` —
 * on a queue base the entry is the only evidence there will ever be —
 * so the badge has to read both or it goes dark on exactly the repos
 * that use a queue.
 */
import { describe, expect, test } from "bun:test";

import type { MergeQueueEntry, PullRequest } from "../core/types.ts";
import { armedFromPr, prStateBadge } from "./badges.ts";
import { theme } from "./theme.ts";

const pr = (over: Partial<PullRequest> = {}): PullRequest =>
  ({
    number: 1,
    state: "OPEN",
    isDraft: false,
    autoMerge: null,
    requestedReviewers: [],
    checks: "none",
    review: "none",
    ...over,
  }) as PullRequest;

const queued = { position: 1, state: "AWAITING_CHECKS" } as MergeQueueEntry;

describe("armedFromPr", () => {
  test("classic auto-merge arms it", () => {
    expect(armedFromPr(pr({ autoMerge: { enabledAt: "z", mergeMethod: "SQUASH" } }), null)).toBe(
      true,
    );
  });

  test("a queue entry arms it even with autoMerge null", () => {
    expect(armedFromPr(pr(), queued)).toBe(true);
  });

  test("neither is unarmed, and an absent entry is not an unknown", () => {
    expect(armedFromPr(pr(), null)).toBe(false);
    expect(armedFromPr(pr(), undefined)).toBe(false);
  });
});

describe("prStateBadge", () => {
  test("an armed open PR is lit, an unarmed one is not", () => {
    expect(prStateBadge(pr(), queued).fg).toBe(theme.accent);
    expect(prStateBadge(pr(), null).fg).toBe(theme.accentAlt);
  });

  // The glyph still says "open", because it is. Only the colour moves.
  test("arming never changes the glyph", () => {
    expect(prStateBadge(pr(), queued).glyph).toBe(prStateBadge(pr(), null).glyph);
  });

  // A draft can carry an armed flag; it is still a draft, and the dim
  // draft glyph is the more important thing about it.
  test("draft/merged/closed are unaffected by arming", () => {
    expect(prStateBadge(pr({ isDraft: true }), queued).fg).toBe(theme.fgDim);
    expect(prStateBadge(pr({ state: "MERGED" }), queued).fg).toBe(theme.info);
    expect(prStateBadge(pr({ state: "CLOSED" }), queued).fg).toBe(theme.err);
  });

  test("the mq argument is optional — callers without one get unarmed", () => {
    expect(prStateBadge(pr()).fg).toBe(theme.accentAlt);
  });
});
