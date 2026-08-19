import { describe, expect, test } from "bun:test";

import {
  effectiveWorkState,
  isGated,
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
