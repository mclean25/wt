/**
 * Day bucketing for the removed-worktree history (`h`).
 *
 * A "day" here starts at 04:00 LOCAL, not midnight. The list exists to
 * be reviewed after the fact, and a worktree destroyed at 01:30 belongs
 * with the session that destroyed it rather than with the morning that
 * had not started yet — a midnight boundary splits one working night
 * across two headers, which is precisely the review the headers are
 * meant to make easy.
 *
 * The roll-back is done on LOCAL CALENDAR FIELDS (`setDate(getDate()-1)`),
 * never by subtracting four hours of absolute time. Both agree on an
 * ordinary day; only the calendar-field form stays correct across a DST
 * transition, where a fixed-millisecond shift silently moves the
 * boundary to 03:00 or 05:00. `setDate` also carries month and year
 * rollover for free.
 */

/** Local hour a day starts at. Not configurable until someone wants it. */
export const DAY_START_HOUR = 4;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** `YYYY-MM-DD` of a local Date's calendar fields. */
function keyOf(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Bucket key for a local timestamp, rolling back before `startHour`. */
export function dayBucketFromMs(ms: number, startHour = DAY_START_HOUR): string {
  const d = new Date(ms);
  if (d.getHours() < startHour) d.setDate(d.getDate() - 1);
  return keyOf(d);
}

/**
 * Bucket key for an ISO timestamp, or null when unparsable — the same
 * `null`-means-unknown the age cell uses, so a corrupt `removedAt`
 * degrades to an ungrouped row rather than inventing a day for it.
 */
export function dayBucket(iso: string, startHour = DAY_START_HOUR): string | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? dayBucketFromMs(t, startHour) : null;
}

/**
 * Header text for a bucket: "today" / "yesterday" relative to `nowMs`
 * (both measured with the same 04:00 boundary, so at 01:00 "today" is
 * still the previous calendar date), otherwise "Mon 18 Aug". No year:
 * the history is capped at 14 days, so a bare day and month cannot be
 * ambiguous.
 */
export function dayLabel(
  bucket: string,
  nowMs: number = Date.now(),
  startHour = DAY_START_HOUR,
): string {
  if (bucket === dayBucketFromMs(nowMs, startHour)) return "today";
  const y = new Date(nowMs);
  y.setDate(y.getDate() - 1);
  if (bucket === dayBucketFromMs(y.getTime(), startHour)) return "yesterday";
  const [year, month, day] = bucket.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return bucket;
  const d = new Date(year, month - 1, day);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
