/**
 * Shared text-formatting constants and helpers for the TUI.
 *
 * Use the same ellipsis glyph opentui's native `truncate` flag emits
 * (3-cell ASCII `...`). Mixing this and the 1-cell `…` in the same
 * pane reads as a font/encoding bug at a glance — keep them in sync.
 */
import { humanAge } from "../core/locks.ts";

export const ELLIPSIS = "...";
export const ELLIPSIS_WIDTH = 3;

/**
 * Format a millisecond delta as a human-readable age string ("12m",
 * "3h", "5d", …). Negative deltas clamp to zero — common when system
 * clocks drift relative to file timestamps.
 */
export function ageMsToText(ms: number): string {
  return humanAge(Math.max(0, ms) / 1000);
}

/**
 * End-truncate `s` to fit within `maxWidth` terminal cells, suffixing
 * `...` when it overflows. Trailing whitespace is stripped before the
 * suffix so a cut at a word boundary reads as `Do foo...` rather than
 * `Do foo ...`.
 *
 * Used in JS where opentui's native `truncate` flag isn't a fit
 * (middle-truncation, or layout that needs to know the final string
 * width). Glyph matches the native flag for visual consistency.
 */
/**
 * Word-wrap `s` into lines of at most `width` terminal cells, with an
 * optional narrower `firstWidth` for hanging-indent layouts (a first
 * line that shares its row with a fixed-width prefix).
 *
 * Hand-rolled rather than opentui's `wrapMode="word"` because the native
 * wrapper (in the Zig text buffer) keeps the whitespace it broke on — so
 * continuation lines start indented by however many spaces the break ate
 * — and drops the break character when the tail lands exactly at the
 * edge, which was eating a trailing `.` and emitting a blank line in its
 * place. Here every run of whitespace collapses to one space, explicit
 * newlines survive as breaks, and words wider than the budget hard-break
 * rather than overflowing the pane.
 */
export function wrapText(s: string, width: number, firstWidth = width): string[] {
  if (width <= 0 || firstWidth <= 0) return [];
  const out: string[] = [];
  let line = "";
  let lineW = 0;
  // The narrower budget applies to the first emitted line only; every
  // continuation gets the full width.
  const budget = () => (out.length === 0 ? firstWidth : width);
  const breakLine = () => {
    out.push(line);
    line = "";
    lineW = 0;
  };
  for (const para of s.split(/\r?\n/)) {
    for (const word of para.split(/\s+/)) {
      if (!word) continue;
      const w = Bun.stringWidth(word);
      if (lineW > 0 && lineW + 1 + w <= budget()) {
        line += ` ${word}`;
        lineW += 1 + w;
        continue;
      }
      if (lineW > 0) breakLine();
      if (w <= budget()) {
        line = word;
        lineW = w;
        continue;
      }
      // Over-long word (a URL, a path): hard-break it by cells. Same
      // deliberately non-grapheme-aware trim as `truncateEnd`.
      let rest = word;
      while (Bun.stringWidth(rest) > budget()) {
        let cut = rest;
        while (cut.length > 0 && Bun.stringWidth(cut) > budget()) cut = cut.slice(0, -1);
        // Pathological only: a wide glyph against a 1-cell budget, where
        // no prefix fits. Emit the glyph anyway so the loop terminates.
        if (cut.length === 0) cut = rest.slice(0, 1);
        out.push(cut);
        rest = rest.slice(cut.length);
      }
      line = rest;
      lineW = Bun.stringWidth(rest);
    }
    // A newline in the source is a hard break; an empty paragraph keeps
    // its blank line.
    if (lineW > 0) breakLine();
    else if (para.trim() === "") out.push("");
  }
  return out;
}

export function truncateEnd(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (Bun.stringWidth(s) <= maxWidth) return s;
  if (maxWidth < ELLIPSIS_WIDTH) return ELLIPSIS.slice(0, maxWidth);
  let cut = s;
  // Code-unit trim, deliberately NOT grapheme-aware: cutting through a
  // surrogate pair can leave a dangling half before the ellipsis. Known
  // and accepted — inputs here (slugs, branch names, titles) are
  // overwhelmingly ASCII and the worst case is one mojibake cell;
  // grapheme segmentation isn't worth it on this hot render path.
  while (cut.length > 0 && Bun.stringWidth(cut) + ELLIPSIS_WIDTH > maxWidth) {
    cut = cut.slice(0, -1);
  }
  return `${cut.trimEnd()}${ELLIPSIS}`;
}
