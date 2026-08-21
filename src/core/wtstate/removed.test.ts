/**
 * The removed-history work record. `reapWtState` drops the per-slug
 * record along with the worktree, so the copy stamped here is the only
 * place the answer survives — and without it "merged, verified, then
 * swept" and "swept while a deployed-environment check was still owed"
 * are the same empty answer. That silence cost a fleet coordinator an
 * issue filed to preserve a check already run and recorded.
 */
import { describe, expect, test } from "bun:test";

import type { RemovedWorktree } from "./types.ts";
import { removedJsonEntry, verificationOwedAtRemoval } from "./removed.ts";

const base: RemovedWorktree = {
  slug: "s",
  branch: "michael/s",
  removedAt: "2026-08-21T19:01:21.431Z",
  prNumber: 1359,
  prState: "MERGED",
};

const owing: RemovedWorktree = {
  ...base,
  work: { state: "ready", at: "z", verifyAfterMerge: "read the check name on a draft PR" },
};

describe("verificationOwedAtRemoval", () => {
  test("steps recorded and never discharged is owed", () => {
    expect(verificationOwedAtRemoval(owing)).toBe(true);
  });

  test("verified is the discharge and dropped voids it", () => {
    expect(
      verificationOwedAtRemoval({ ...owing, work: { ...owing.work!, state: "verified" } }),
    ).toBe(false);
    expect(
      verificationOwedAtRemoval({ ...owing, work: { ...owing.work!, state: "dropped" } }),
    ).toBe(false);
  });

  test("no steps and no record are both not-owed", () => {
    expect(verificationOwedAtRemoval({ ...base, work: { state: "ready", at: "z" } })).toBe(
      false,
    );
    expect(verificationOwedAtRemoval(base)).toBe(false);
  });

  // Deliberately NOT `owesPostMergeVerification`, which gates on the
  // branch having landed. By the time a row is in this history the
  // checkout is gone either way, so an obligation on a branch that
  // never landed is exactly as unresolved.
  test("an unlanded removal still owes", () => {
    const { prNumber: _p, prState: _s, ...unlanded } = owing;
    expect(verificationOwedAtRemoval(unlanded as RemovedWorktree)).toBe(true);
  });
});

describe("removedJsonEntry", () => {
  // All three commands that append removed history share this entry, so
  // a field added for one of them reaches the other two by construction.
  test("carries the work status flat, matching wt status --all --json", () => {
    const e = removedJsonEntry(owing);
    expect(e.work_state).toBe("ready");
    expect(e.verify_after_merge).toBe("read the check name on a draft PR");
    expect(e.verification_owed).toBe(true);
  });

  test("a discharged obligation reports the steps but is not owed", () => {
    const e = removedJsonEntry({
      ...owing,
      work: { ...owing.work!, state: "verified", note: "checked #1379 and #1412 on staging" },
    });
    expect(e.work_state).toBe("verified");
    expect(e.verification_owed).toBe(false);
    // Kept rather than blanked: the steps are what the note is ABOUT.
    expect(e.verify_after_merge).not.toBeNull();
  });

  // An entry written before the field existed reads as unknown. Absence
  // of a value never means "fine" — `work_state: null` is the tell, and
  // it is why `verification_owed` alone would be the wrong surface.
  test("a record-less entry is unknown, not clean", () => {
    const e = removedJsonEntry(base);
    expect(e.work_state).toBeNull();
    expect(e.verify_after_merge).toBeNull();
    expect(e.verification_owed).toBe(false);
  });
});
