import { describe, expect, test } from "bun:test";

import {
  effectiveWorkState,
  isGated,
  owesPostMergeVerification,
  verificationOverdue,
  WORK_STATES,
  workRecordRank,
  workStatusSuffix,
  isWorkStatusStale,
  BLOCKED_RANK,
  LANDED_RANK,
  NO_STATUS_RANK,
  parseWorkStatus,
  resolveWorkState,
  workAge,
  workStateRank,
  sameWorkClaim,
} from "./work-status.ts";

describe("resolveWorkState", () => {
  test("exact ids resolve", () => {
    expect(resolveWorkState("ready")).toBe("ready");
    expect(resolveWorkState("needs-human")).toBe("needs-human");
  });

  test("unique prefixes resolve", () => {
    expect(resolveWorkState("w")).toBe("working");
    expect(resolveWorkState("rev")).toBe("review");
    expect(resolveWorkState("rea")).toBe("ready");
    expect(resolveWorkState("t")).toBe("todo");
  });

  test("aliases cover the shared needs- prefix", () => {
    expect(resolveWorkState("nh")).toBe("needs-human");
    expect(resolveWorkState("nt")).toBe("needs-testing");
    expect(resolveWorkState("human")).toBe("needs-human");
    expect(resolveWorkState("testing")).toBe("needs-testing");
  });

  test("ambiguous and unknown input resolve to null", () => {
    expect(resolveWorkState("r")).toBeNull(); // review | ready
    expect(resolveWorkState("needs-")).toBeNull(); // human | testing
    expect(resolveWorkState("done")).toBeNull();
    expect(resolveWorkState("")).toBeNull();
  });
});

describe("workStateRank", () => {
  test("orders by urgency with statusless neutral and landed last", () => {
    const ranks = [
      workStateRank("ready"),
      workStateRank("needs-human"),
      workStateRank("needs-testing"),
      workStateRank("review"),
      workStateRank("working"),
      BLOCKED_RANK,
      NO_STATUS_RANK,
      workStateRank("todo"),
      LANDED_RANK,
    ];
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(workStateRank(null)).toBe(NO_STATUS_RANK);
    expect(workStateRank(undefined)).toBe(NO_STATUS_RANK);
  });
});

describe("effectiveWorkState", () => {
  const ready = { state: "ready", at: "2026-08-08T00:00:00Z" } as const;

  test("session asking overrides any assertion", () => {
    expect(effectiveWorkState(ready, "asking")).toEqual({
      state: "needs-human",
      derived: true,
      blocked: false,
    });
    expect(effectiveWorkState(null, "asking")).toEqual({
      state: "needs-human",
      derived: true,
      blocked: false,
    });
  });

  test("otherwise the assertion stands, or nothing", () => {
    expect(effectiveWorkState(ready, "working")).toEqual({
      state: "ready",
      derived: false,
      blocked: false,
    });
    expect(effectiveWorkState(null, "idle")).toBeNull();
    expect(effectiveWorkState(undefined, undefined)).toBeNull();
  });
});

describe("parseWorkStatus", () => {
  test("round-trips a full record", () => {
    const rec = {
      state: "ready",
      note: "calendar integrations may need a resync",
      risk: "medium",
      at: "2026-08-08T12:00:00.000Z",
      sha: "abc123",
    } as const;
    expect(parseWorkStatus(rec)).toEqual(rec);
  });

  test("drops records with unknown state or missing at", () => {
    expect(parseWorkStatus({ state: "shipped", at: "2026-08-08" })).toBeNull();
    expect(parseWorkStatus({ state: "ready" })).toBeNull();
    expect(parseWorkStatus("ready")).toBeNull();
    expect(parseWorkStatus(null)).toBeNull();
  });

  test("drops invalid risk but keeps the record", () => {
    expect(
      parseWorkStatus({ state: "ready", at: "t", risk: "yolo", note: " " }),
    ).toEqual({ state: "ready", at: "t" });
  });
});

describe("workAge", () => {
  const now = Date.parse("2026-08-08T12:00:00Z");
  test("compact units", () => {
    expect(workAge("2026-08-08T11:59:30Z", now)).toBe("30s");
    expect(workAge("2026-08-08T11:30:00Z", now)).toBe("30m");
    expect(workAge("2026-08-08T06:00:00Z", now)).toBe("6h");
    expect(workAge("2026-08-05T12:00:00Z", now)).toBe("3d");
    expect(workAge("not a date", now)).toBeNull();
  });
});

describe("isWorkStatusStale", () => {
  const at = "2026-08-08T12:00:00.000Z";
  const record = { state: "ready" as const, at };
  const atMs = Date.parse(at);

  test("commits after the assertion make it stale", () => {
    expect(isWorkStatusStale(record, atMs + 60_000)).toBe(true);
  });

  test("commits before the assertion do not", () => {
    expect(isWorkStatusStale(record, atMs - 60_000)).toBe(false);
  });

  test("unknown commit signal never reads as stale", () => {
    expect(isWorkStatusStale(record, null)).toBe(false);
    expect(isWorkStatusStale(record, undefined)).toBe(false);
  });

  test("no record is never stale", () => {
    expect(isWorkStatusStale(null, atMs)).toBe(false);
    expect(isWorkStatusStale(undefined, atMs)).toBe(false);
  });

  test("an unparseable assertion timestamp is not stale", () => {
    expect(isWorkStatusStale({ state: "ready", at: "garbage" }, atMs)).toBe(false);
  });
});


// ---------------------------------------------------------------------------
// The external merge gate (`--blocked-on`)
// ---------------------------------------------------------------------------

const at = "2026-08-18T00:00:00Z";

describe("isGated", () => {
  test("a ready carrying a gate is blocked", () => {
    expect(isGated({ state: "ready", at, blockedOn: "mobile 2.14" })).toBe(true);
  });

  test("a plain ready is not", () => {
    expect(isGated({ state: "ready", at })).toBe(false);
    expect(isGated(null)).toBe(false);
    expect(isGated(undefined)).toBe(false);
  });

  // state.json is hand-editable and older/newer wt versions write it.
  // One predicate decides what "blocked" means so a stray gate is inert
  // EVERYWHERE rather than honoured by the dot and ignored by the sort.
  // The verb comes from the state: ready + gate = do not MERGE yet,
  // todo + gate = do not START yet.
  test("a todo can be gated too", () => {
    expect(isGated({ state: "todo", at, blockedOn: "the .env secrets land" })).toBe(true);
  });

  test("a gate on any other state is inert", () => {
    for (const state of WORK_STATES) {
      if (state === "ready" || state === "todo") continue;
      expect(isGated({ state, at, blockedOn: "something" })).toBe(false);
    }
  });
});

describe("workRecordRank", () => {
  // The bug this whole field exists for: a gated branch sitting in the
  // top merge band is a branch that gets merged, because that band is
  // what a human scans for what to merge next.
  test("a gated ready leaves the merge band entirely", () => {
    const plain = workRecordRank({ state: "ready", at });
    const gated = workRecordRank({ state: "ready", at, blockedOn: "mobile 2.14" });
    expect(plain).toBe(workStateRank("ready"));
    expect(gated).toBeGreaterThan(workStateRank("working"));
    expect(gated).toBe(BLOCKED_RANK);
  });

  // Finished work that will need merging once the world moves — it must
  // not sink below rows nobody has started.
  test("but still outranks statusless and todo", () => {
    const gated = workRecordRank({ state: "ready", at, blockedOn: "x" });
    expect(gated).toBeLessThan(NO_STATUS_RANK);
    expect(gated).toBeLessThan(workStateRank("todo"));
  });

  // A held todo must not sit among the todos someone could actually
  // pick up, and must not sink below `dropped` either — it is still
  // going to happen.
  test("a gated todo sorts below plain todo and above dropped", () => {
    const gated = workRecordRank({ state: "todo", at, blockedOn: "secrets land" });
    expect(gated).toBeGreaterThan(workStateRank("todo"));
    expect(gated).toBeLessThan(workStateRank("dropped"));
  });

  test("agrees with workStateRank for every ungated record", () => {
    for (const state of WORK_STATES) {
      expect(workRecordRank({ state, at })).toBe(workStateRank(state));
    }
    expect(workRecordRank(null)).toBe(NO_STATUS_RANK);
  });
});

describe("effectiveWorkState with a gate", () => {
  test("reports blocked alongside the asserted state, not instead of it", () => {
    expect(
      effectiveWorkState({ state: "ready", at, blockedOn: "mobile 2.14" }, "idle"),
    ).toEqual({ state: "ready", derived: false, blocked: true });
  });

  // The session-asking override is live information about right now;
  // a gate is a claim about the record. Asking wins the dot, and
  // nothing about it is "blocked".
  test("a session asking still overrides, without inheriting the gate", () => {
    expect(
      effectiveWorkState({ state: "ready", at, blockedOn: "mobile 2.14" }, "asking"),
    ).toEqual({ state: "needs-human", derived: true, blocked: false });
  });
});

describe("workStatusSuffix with a gate", () => {
  // Ahead of the note on purpose: every surface inherits this string,
  // and the gate losing the last cells of a truncated line to a long
  // note is the original failure in miniature.
  test("puts the gate before the note", () => {
    expect(
      workStatusSuffix({ risk: "low", blockedOn: "mobile 2.14", note: "some note" }),
    ).toBe(" (risk: low) [blocked on: mobile 2.14] — some note");
  });

  test("omits it entirely when there is no gate", () => {
    expect(workStatusSuffix({ risk: "low", note: "n" })).toBe(" (risk: low) — n");
  });
});

describe("parseWorkStatus with a gate", () => {
  test("round-trips and sanitizes it like a note", () => {
    const rec = parseWorkStatus({
      state: "ready",
      at,
      blockedOn: "mobile 2.14\tshipped",
    });
    expect(rec?.blockedOn).toBe("mobile 2.14 shipped");
  });

  test("a blank gate is no gate", () => {
    expect(parseWorkStatus({ state: "ready", at, blockedOn: "   " })?.blockedOn).toBeUndefined();
    expect(parseWorkStatus({ state: "ready", at, blockedOn: 7 })?.blockedOn).toBeUndefined();
  });
});


describe("verifyAfterMerge", () => {
  const at = new Date().toISOString();
  const owed = { state: "ready" as const, at, verifyAfterMerge: "connect gcal" };

  // The whole point of the field: it is inert until the branch lands,
  // so it can never drag a mergeable row out of the merge band. That
  // is the one behaviour separating it from `blockedOn`, and the one
  // that would make it a second `blockedOn` if it broke.
  test("is dormant before the branch lands", () => {
    expect(owesPostMergeVerification(owed, false)).toBe(false);
    expect(workRecordRank(owed)).toBe(workStateRank("ready"));
    expect(effectiveWorkState(owed, "idle", false)).toEqual({
      state: "ready",
      derived: false,
      blocked: false,
    });
  });

  test("comes due on landing and renders as needs-testing", () => {
    expect(owesPostMergeVerification(owed, true)).toBe(true);
    expect(effectiveWorkState(owed, "idle", true)).toEqual({
      state: "needs-testing",
      derived: true,
      blocked: false,
    });
  });

  test("verified and dropped are its two exits", () => {
    for (const state of ["verified", "dropped"] as const) {
      expect(owesPostMergeVerification({ ...owed, state }, true)).toBe(false);
    }
  });

  // A session waiting on a prompt still wins the dot: it is live
  // information about right now, where this is a standing obligation.
  test("an asking session still outranks it", () => {
    expect(effectiveWorkState(owed, "asking", true)?.state).toBe("needs-human");
  });

  test("the suffix carries it ahead of the note", () => {
    const s = workStatusSuffix({ ...owed, note: "the note" });
    expect(s.indexOf("verify after merge")).toBeLessThan(s.indexOf("the note"));
  });

  test("it survives a parse round-trip and is sanitized", () => {
    const parsed = parseWorkStatus({
      state: "ready",
      at,
      verifyAfterMerge: "connect \u001b[31mgcal\u001b[0m",
    });
    expect(parsed?.verifyAfterMerge).toBe("connect gcal");
  });

  // Kept regardless of state, because unlike a gate this one
  // legitimately outlives the assertion that created it — one place
  // (`owesPostMergeVerification`) decides whether it is still owed.
  test("parse keeps it on any state", () => {
    expect(
      parseWorkStatus({ state: "working", at, verifyAfterMerge: "x" })?.verifyAfterMerge,
    ).toBe("x");
  });
});

describe("verificationOverdue", () => {
  const now = Date.parse("2026-08-20T12:00:00Z");
  const owed = (at: string) => ({ state: "ready" as const, at, verifyAfterMerge: "x" });

  test("not overdue inside the window", () => {
    expect(verificationOverdue(owed("2026-08-19T12:00:00Z"), true, now, 2)).toBe(false);
  });

  test("overdue at the boundary and past it", () => {
    expect(verificationOverdue(owed("2026-08-18T12:00:00Z"), true, now, 2)).toBe(true);
    expect(verificationOverdue(owed("2026-08-01T12:00:00Z"), true, now, 2)).toBe(true);
  });

  // An obligation nothing can act on yet cannot be late.
  test("an unlanded branch is never overdue", () => {
    expect(verificationOverdue(owed("2020-01-01T00:00:00Z"), false, now, 2)).toBe(false);
  });

  // The one place unknown fails LOUD rather than quiet: a record whose
  // age cannot be established must not be the one that goes silent.
  test("an unparsable timestamp reads as overdue", () => {
    expect(verificationOverdue(owed("not a date"), true, now, 2)).toBe(true);
  });

  test("nothing owed is never overdue", () => {
    expect(
      verificationOverdue({ state: "ready", at: new Date(now).toISOString() }, true, now),
    ).toBe(false);
  });
});

/**
 * The idempotent re-assert guard's equality test. It used to hand-list
 * four fields in `setSlugWorkStatus`, and the list drifted the moment a
 * fifth existed: amending ONLY a gate, or ONLY the post-merge steps,
 * compared equal and the write was dropped — while the CLI echoed the
 * record it had built in memory, confirming a store that never
 * happened. `CLAIM_FIELDS` is now total over the record type, so a new
 * field cannot compile until it is classified; these pin the semantics
 * that classification produces.
 */
describe("sameWorkClaim", () => {
  const base = {
    state: "ready",
    risk: "low",
    note: "n",
    at: "2026-08-20T12:00:00.000Z",
    sha: "abc",
  } as const;

  test("the two fields the drifted list missed each break equality", () => {
    expect(sameWorkClaim(base, { ...base, verifyAfterMerge: "check the grant" })).toBe(false);
    expect(sameWorkClaim(base, { ...base, blockedOn: "mobile release" })).toBe(false);
  });

  test("REPLACING either one breaks equality too — not just adding it", () => {
    // The reported bug: a row that already owed a check could not have
    // those steps corrected, which made the only exits `verified` (a
    // lie) or `dropped` (worse).
    const owed = { ...base, verifyAfterMerge: "old steps" };
    expect(sameWorkClaim(owed, { ...owed, verifyAfterMerge: "new steps" })).toBe(false);
    const gated = { ...base, blockedOn: "old gate" };
    expect(sameWorkClaim(gated, { ...gated, blockedOn: "new gate" })).toBe(false);
  });

  test("dropping an optional field is a change", () => {
    const owed = { ...base, verifyAfterMerge: "steps" };
    expect(sameWorkClaim(owed, base)).toBe(false);
  });

  test("absent and undefined compare alike", () => {
    expect(sameWorkClaim(base, { ...base, verifyAfterMerge: undefined })).toBe(true);
  });

  test("at and by are excluded — preserving `at` IS the point", () => {
    expect(sameWorkClaim(base, { ...base, at: "2026-01-01T00:00:00.000Z" })).toBe(true);
    expect(sameWorkClaim(base, { ...base, by: "someone-else" })).toBe(true);
  });

  test("a genuinely identical re-assert still compares equal", () => {
    expect(sameWorkClaim(base, { ...base })).toBe(true);
  });
});
