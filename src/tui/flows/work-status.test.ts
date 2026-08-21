/**
 * The `u` picker's two departures from "a pick replaces the whole
 * record": a post-merge verification is a standing obligation about the
 * BRANCH rather than a claim made by one assertion, so an ordinary pick
 * carries it — and the row that exists to SET it is the one place a
 * human can take it back off without claiming `verified`.
 */
import { describe, expect, test } from "bun:test";

import type { WorkStatusRecord } from "../../core/work-status.ts";
import {
  carriedVerify,
  statusPickerItems,
  statusTextRecord,
  VERIFY_CHORD,
  WORK_STATE_CHORDS,
} from "./work-status.ts";

const owed: WorkStatusRecord = {
  state: "ready",
  at: "2026-08-20T12:00:00Z",
  verifyAfterMerge: "connect gcal on staging",
};

describe("carriedVerify", () => {
  test("an ordinary pick keeps the obligation", () => {
    expect(carriedVerify(owed, "working")).toEqual({
      verifyAfterMerge: "connect gcal on staging",
    });
  });

  test("its two exits drop it", () => {
    expect(carriedVerify(owed, "verified")).toEqual({});
    expect(carriedVerify(owed, "dropped")).toEqual({});
  });

  test("nothing owed carries nothing", () => {
    expect(carriedVerify({ state: "ready", at: owed.at }, "working")).toEqual({});
    expect(carriedVerify(null, "working")).toEqual({});
    expect(carriedVerify(undefined, "working")).toEqual({});
  });
});

describe("picker chords", () => {
  // The picker reserves j/k/u/q and the digits; a chord colliding with
  // one of those is a key that silently does the wrong thing. `x` is
  // reserved only in the sense that the clear ROW owns it.
  test("every row has a distinct, non-reserved chord", () => {
    const chords = statusPickerItems(null).map((it) => it.chord);
    expect(new Set(chords).size).toBe(chords.length);
    for (const c of chords) expect("jkuq0123456789").not.toContain(c);
    expect(chords).toContain(VERIFY_CHORD);
    expect(chords).toContain("x");
    for (const c of Object.values(WORK_STATE_CHORDS)) expect(chords).toContain(c);
  });

  // Labels are the list's React keys and scroll ids — a duplicate
  // silently collapses two rows into one.
  test("every row has a distinct label", () => {
    for (const rec of [null, owed, { state: "ready", at: owed.at } as WorkStatusRecord]) {
      const labels = statusPickerItems(rec).map((it) => it.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});

describe("statusPickerItems", () => {
  test("ready appears twice — plain and + verify", () => {
    const ready = statusPickerItems(null).filter((it) => it.state === "ready");
    expect(ready.map((it) => it.verify ?? false)).toEqual([false, true]);
  });

  // The picker is the legend for the list's dots, and the two `ready`
  // rows would otherwise be indistinguishable at a glance — which is
  // the one thing a separate row exists to avoid.
  test("the verify row wears the dot the board will show it", () => {
    const [plain, verify] = statusPickerItems(null).filter(
      (it) => it.state === "ready",
    );
    expect(plain!.glyphState).toBeUndefined();
    expect(verify!.glyphState).toBe("needs-testing");
  });

  test("every other row's dot is its own state", () => {
    for (const it of statusPickerItems(null)) {
      if (it.verify) continue;
      expect(it.glyphState).toBeUndefined();
    }
  });

  test("no record marks nothing current", () => {
    expect(statusPickerItems(null).filter((it) => it.current)).toEqual([]);
  });

  // The pair splits on the obligation, not the state, so exactly one of
  // them can be current — otherwise the picker opens on a row that
  // would drop the steps if the human just pressed Enter.
  test("a plain ready record is current on the plain row", () => {
    const items = statusPickerItems({ state: "ready", at: owed.at });
    const current = items.filter((it) => it.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.verify).toBeUndefined();
  });

  test("an owed ready record is current on the verify row", () => {
    const current = statusPickerItems(owed).filter((it) => it.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.verify).toBe(true);
  });

  test("a non-ready record owing verification marks its own row", () => {
    const items = statusPickerItems({ ...owed, state: "needs-testing" });
    const current = items.filter((it) => it.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.state).toBe("needs-testing");
  });
});

describe("statusTextRecord", () => {
  const at = "2026-08-21T09:00:00Z";

  test("a note lands in the note field and keeps the carried obligation", () => {
    expect(
      statusTextRecord(
        { slug: "s", state: "working", field: "note", verifyAfterMerge: "check gcal" },
        "  poking at it  ",
        at,
      ),
    ).toEqual({
      state: "working",
      at,
      note: "poking at it",
      verifyAfterMerge: "check gcal",
    });
  });

  test("an empty note is a plain pick that still keeps the obligation", () => {
    expect(
      statusTextRecord(
        { slug: "s", state: "working", field: "note", verifyAfterMerge: "check gcal" },
        "   ",
        at,
      ),
    ).toEqual({ state: "working", at, verifyAfterMerge: "check gcal" });
  });

  test("the verify row's line lands in verifyAfterMerge", () => {
    expect(
      statusTextRecord(
        { slug: "s", state: "ready", field: "verifyAfterMerge" },
        " connect gcal on staging ",
        at,
      ),
    ).toEqual({ state: "ready", at, verifyAfterMerge: "connect gcal on staging" });
  });

  // The input is pre-filled with the current steps, so emptying it is a
  // deliberate erase, not an omission. This is the one path that drops
  // an obligation without `verified`/`dropped`; the flow's toast says so.
  test("emptying the pre-filled verify box drops the obligation", () => {
    expect(
      statusTextRecord({ slug: "s", state: "ready", field: "verifyAfterMerge" }, "", at),
    ).toEqual({ state: "ready", at });
  });

  test("the verify row never writes a note", () => {
    const rec = statusTextRecord(
      { slug: "s", state: "ready", field: "verifyAfterMerge" },
      "run the smoke list",
      at,
    );
    expect(rec.note).toBeUndefined();
  });
});
