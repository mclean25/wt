import { describe, expect, test } from "bun:test";

import { parseEventLine } from "./activity-backfill.ts";

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
});
