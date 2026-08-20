import { describe, expect, test } from "bun:test";

import { dayBucket, dayBucketFromMs, dayLabel } from "./day-headers.ts";

/** Local-time Date, so these assertions read in the zone the UI renders in. */
function at(y: number, m: number, d: number, h: number, min = 0): number {
  return new Date(y, m - 1, d, h, min).getTime();
}

describe("dayBucketFromMs", () => {
  test("an ordinary afternoon buckets to its own date", () => {
    expect(dayBucketFromMs(at(2026, 8, 18, 14))).toBe("2026-08-18");
  });

  test("before 04:00 belongs to the previous day", () => {
    // The whole point: a worktree destroyed at 01:30 belongs with the
    // session that destroyed it, not with a morning that hasn't started.
    expect(dayBucketFromMs(at(2026, 8, 18, 1, 30))).toBe("2026-08-17");
  });

  test("04:00 exactly is the new day", () => {
    expect(dayBucketFromMs(at(2026, 8, 18, 4, 0))).toBe("2026-08-18");
    expect(dayBucketFromMs(at(2026, 8, 18, 3, 59))).toBe("2026-08-17");
  });

  test("rolls back across a month boundary", () => {
    expect(dayBucketFromMs(at(2026, 9, 1, 2))).toBe("2026-08-31");
  });

  test("rolls back across a year boundary", () => {
    expect(dayBucketFromMs(at(2026, 1, 1, 2))).toBe("2025-12-31");
  });

  test("rolls back into a leap day", () => {
    expect(dayBucketFromMs(at(2028, 3, 1, 2))).toBe("2028-02-29");
  });
});

describe("dayBucket", () => {
  test("parses an ISO timestamp", () => {
    const iso = new Date(at(2026, 8, 18, 14)).toISOString();
    expect(dayBucket(iso)).toBe("2026-08-18");
  });

  test("unparsable input is null, never a fabricated day", () => {
    expect(dayBucket("not a date")).toBeNull();
    expect(dayBucket("")).toBeNull();
  });
});

describe("dayLabel", () => {
  test("today and yesterday are named", () => {
    const now = at(2026, 8, 18, 14);
    expect(dayLabel("2026-08-18", now)).toBe("today");
    expect(dayLabel("2026-08-17", now)).toBe("yesterday");
  });

  test("today and yesterday use the SAME 04:00 boundary as bucketing", () => {
    // At 01:00 on the 18th the current day-bucket is still the 17th, so
    // "today" must mean the 17th here. Measuring "now" at midnight would
    // label the rows you just created as yesterday's.
    const now = at(2026, 8, 18, 1);
    expect(dayLabel("2026-08-17", now)).toBe("today");
    expect(dayLabel("2026-08-16", now)).toBe("yesterday");
    expect(dayLabel("2026-08-18", now)).not.toBe("today");
  });

  test("older days get a weekday, day and month", () => {
    const now = at(2026, 8, 18, 14);
    expect(dayLabel("2026-08-15", now)).toBe("Sat 15 Aug");
  });

  test("yesterday is correct across a month boundary", () => {
    const now = at(2026, 9, 1, 10);
    expect(dayLabel("2026-08-31", now)).toBe("yesterday");
  });

  test("a malformed bucket renders itself rather than throwing", () => {
    expect(dayLabel("garbage", at(2026, 8, 18, 14))).toBe("garbage");
  });
});
