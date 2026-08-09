import { describe, expect, test } from "bun:test";

import { dedupeBursts, parseEventLine } from "./activity-backfill.ts";

// Lines below mirror core/logger.ts `emit()` exactly:
// `${iso} ${tag} ${kind.padEnd(4)} ${source.padEnd(16)} ${text}` with
// tag "EVENT" or "ATTN " (both 5 wide).
const ISO = "2026-08-08T23:35:46.775Z";

describe("parseEventLine", () => {
  test("firehose line round-trips", () => {
    const e = parseEventLine(`${ISO} EVENT dim  [gh]             fetching GitHub...`);
    expect(e).toEqual({
      ts: Date.parse(ISO),
      level: "dim",
      channel: "firehose",
      source: "[gh]",
      text: "fetching GitHub...",
    });
  });

  test("attention line round-trips", () => {
    const e = parseEventLine(`${ISO} ATTN  err  eng-123-fix      needs-human: expired login`);
    expect(e?.channel).toBe("attention");
    expect(e?.level).toBe("err");
    expect(e?.source).toBe("eng-123-fix");
    expect(e?.text).toBe("needs-human: expired login");
  });

  test("source longer than the 16-char pad shifts the text correctly", () => {
    const source = "a-very-long-worktree-slug";
    const e = parseEventLine(`${ISO} EVENT ok   ${source} landed`);
    expect(e?.source).toBe(source);
    expect(e?.text).toBe("landed");
  });

  test("indentation beyond the pad survives as part of the text", () => {
    const e = parseEventLine(`${ISO} EVENT info app                indented line`);
    expect(e?.source).toBe("app");
    expect(e?.text).toBe("  indented line");
  });

  test("non-event records and garbage yield null", () => {
    expect(parseEventLine(`${ISO} DEBUG app              details`)).toBeNull();
    expect(parseEventLine(`${ISO} ERROR app              boom {"stack":"..."}`)).toBeNull();
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine("not a log line at all")).toBeNull();
    expect(parseEventLine(`${ISO} EVENT nope [gh]             text`)).toBeNull();
  });

  test("a short, padded source containing a space round-trips (fixed-width boundary, not first-space)", () => {
    const source = "remote hub"; // fits the 16-char pad; the naive first-space split would cut it at "remote"
    const e = parseEventLine(`${ISO} EVENT info ${source.padEnd(16)} online`);
    expect(e?.source).toBe(source);
    expect(e?.text).toBe("online");
  });

  test("a source longer than the pad, containing a space, round-trips", () => {
    const source = "[remote:My Server]"; // > 16 chars, space lands before the pad boundary
    const e = parseEventLine(`${ISO} EVENT ok   ${source} ready`);
    expect(e?.source).toBe(source);
    expect(e?.text).toBe("ready");
  });

  test("lines below the true minimum (header + full pad + 1 text char) are rejected", () => {
    // The fixed header plus a fully-padded 16-char source, with no text
    // at all — one char short of the shortest possible valid line. Well
    // past the old (too-low) 37-char guard, so this only rejects under
    // the corrected minimum.
    const prefix = `${ISO} EVENT dim  ${"x".padEnd(16)} `;
    expect(prefix.length).toBe(53);
    expect(parseEventLine(prefix)).toBeNull();
    expect(parseEventLine(`${prefix}z`)).not.toBeNull();
  });
});

describe("dedupeBursts", () => {
  const base = Date.parse("2026-08-09T00:28:13.203Z");
  const ev = (ts: number, text: string, source = "meeting-time") => ({
    ts,
    level: "warn" as const,
    channel: "attention" as const,
    source,
    text,
  });

  test("N concurrent-instance copies of one transition collapse to the first", () => {
    // Real shape from the leak incident: one line at .203, three more at
    // .567 — four instances observing the same wtstate write.
    const burst = [
      ev(base, "needs testing"),
      ev(base + 364, "needs testing"),
      ev(base + 364, "needs testing"),
      ev(base + 364, "needs testing"),
    ];
    expect(dedupeBursts(burst)).toEqual([ev(base, "needs testing")]);
  });

  test("genuine repeats outside the window survive", () => {
    const later = base + 3 * 60 * 60 * 1000;
    const out = dedupeBursts([ev(base, "needs testing"), ev(later, "needs testing")]);
    expect(out.length).toBe(2);
  });

  test("same text from different sources is never merged", () => {
    const out = dedupeBursts([
      ev(base, "needs testing", "slug-a"),
      ev(base + 10, "needs testing", "slug-b"),
    ]);
    expect(out.length).toBe(2);
  });
});
