/**
 * The PR glyph's armed colour. "Merge when ready" is two GitHub
 * features wearing one label and only one of them sets `autoMerge` —
 * on a queue base the entry is the only evidence there will ever be —
 * so the badge has to read both or it goes dark on exactly the repos
 * that use a queue.
 */
import { describe, expect, test } from "bun:test";

import type { MergeQueueEntry, PullRequest } from "../core/types.ts";
import { armedFromPr, prSlotBadge, prStateBadge } from "./badges.ts";
import { NF } from "./icons.ts";
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

describe("prSlotBadge", () => {
  // The details pane has room for a dedicated auto-merge segment; the
  // list slot does not, so it swaps — same icon the queue uses, minus a
  // position, in the same colour the details segment already wears.
  test("armed but not queued takes the merge-queue icon", () => {
    const armed = pr({ autoMerge: { enabledAt: "z", mergeMethod: "SQUASH" } });
    expect(prSlotBadge(armed, null)).toEqual({ glyph: NF.mergeQueue, fg: theme.info });
  });

  test("unarmed keeps the PR glyph", () => {
    expect(prSlotBadge(pr(), null)).toEqual(prStateBadge(pr()));
  });

  // Callers render the position themselves when there is a queue entry;
  // the guard is here so one that forgets degrades to the position
  // rather than silently dropping it.
  test("a queue entry outranks the armed icon", () => {
    expect(prSlotBadge(pr(), queued)).toEqual(prStateBadge(pr()));
  });

  // A draft can carry an armed flag. It is still a draft, and that is
  // the more important thing about it.
  test("draft/merged/closed never take the swap", () => {
    const am = { enabledAt: "z", mergeMethod: "SQUASH" } as PullRequest["autoMerge"];
    expect(prSlotBadge(pr({ isDraft: true, autoMerge: am }), null).fg).toBe(theme.fgDim);
    expect(prSlotBadge(pr({ state: "MERGED", autoMerge: am }), null).fg).toBe(theme.info);
    expect(prSlotBadge(pr({ state: "MERGED", autoMerge: am }), null).glyph).toBe(NF.prMerged);
    expect(prSlotBadge(pr({ state: "CLOSED", autoMerge: am }), null).fg).toBe(theme.err);
  });

  test("mq is optional — callers without one get the unarmed glyph", () => {
    expect(prSlotBadge(pr())).toEqual(prStateBadge(pr()));
  });
});
