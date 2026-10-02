/**
 * The error overlay — pops automatically when the process-level capture
 * (src/tui/error-store.ts) records an unhandled exception / rejection /
 * render error, instead of that stack trace being printed raw over the
 * panes. Modeled on the `P` perf overlay: presentational only, reads
 * the ring via `useCapturedErrors`, and the `i` inject flow mirrors
 * perf's (send to the wt-source session, then enter it).
 *
 * All captured errors render newest-first in one scrollbox; `i` and `y`
 * act on the newest (the one that popped the overlay). Stack lines are
 * hard-wrapped in JS to the width budget — the renderer never has to
 * wrap or clip a long frame line, which is what garbles.
 */
import { useTerminalDimensions } from "@opentui/react";

import type { KeyHintPair } from "../key-hint.tsx";
import {
  isProcessDegraded,
  useCapturedErrors,
  type CapturedError,
} from "../error-store.ts";
import { Modal, modalContentWidth } from "../modal.tsx";
import { useOverlayScroll, WtScrollbox } from "../scrollbox.tsx";
import { theme } from "../theme.ts";
import { graphemes, wrapText } from "../text.ts";

/** Status of the `i` inject-and-enter flow, surfaced above the stack. */
export type ErrorInjectState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "failed"; reason: string };

/** Continuation indent for hard-wrapped stack lines. */
const WRAP_INDENT = "      ";

/**
 * Share the shell's width calculation, reserving its scroll gutter.
 */
function useContentWidth(): number {
  const { width } = useTerminalDimensions();
  return Math.max(1, modalContentWidth(width, { left: "6%", right: "6%" }) - 1);
}

/** Hard-wrap one stack line to `width`, indenting continuations. */
function wrapLine(line: string, width: number): string[] {
  if (Bun.stringWidth(line) <= width) return [line];
  const out: string[] = [];
  const indent = WRAP_INDENT.slice(0, Math.max(0, width - 2));
  let part = "";
  let cells = 0;
  for (const ch of graphemes(line)) {
    const size = Bun.stringWidth(ch);
    if (cells + size > width && part) {
      out.push(part);
      part = indent;
      cells = indent.length;
    }
    part += size > width ? "�" : ch;
    cells += size > width ? 1 : size;
  }
  if (part) out.push(part);
  return out;
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function ErrorBlock({
  error,
  width,
  latest,
}: {
  error: CapturedError;
  width: number;
  latest: boolean;
}) {
  const repeat =
    error.count > 1 ? `  ×${error.count} (last ${clock(error.lastAt)})` : "";
  const stackLines = error.stack
    .split("\n")
    .flatMap((line) => wrapLine(line, width));
  return (
    <box flexDirection="column" marginBottom={1} flexShrink={0}>
      <box backgroundColor={theme.rowSelectedBg} paddingLeft={1} flexShrink={0}>
        <text wrapMode="none" truncate>
          <span fg={latest ? theme.err : theme.fgDim} attributes={1}>
            {error.origin}
          </span>
          <span fg={theme.fgDim}>{`  ${clock(error.at)}${repeat}`}</span>
        </text>
      </box>
      {stackLines.map((line, i) => (
        <text key={i} fg={i === 0 ? theme.fgBright : theme.fg} wrapMode="none" flexShrink={0}>
          {line}
        </text>
      ))}
    </box>
  );
}

export function ErrorOverlay({ inject }: { inject: ErrorInjectState }) {
  const errors = useCapturedErrors();
  const contentW = useContentWidth();
  // Scrolling comes from `handleOverlayScrollKey` (modal-keys/errors.ts),
  // not the focused-scrollbox built-in — shared overlay keymap.
  const scrollRef = useOverlayScroll();
  const hints: KeyHintPair[] = [
    ["j k", "scroll"],
    ["i", "investigate in wt session"],
    ["y", "copy"],
    ["esc / q", "dismiss"],
  ];
  const newestFirst = [...errors].reverse();
  const injectLine =
    inject.kind === "sending" ? (
      <text fg={theme.accent} flexShrink={0} wrapMode="none">{wrapText("sending error to the wt session…", contentW).join("\n")}</text>
    ) : inject.kind === "failed" ? (
      <text fg={theme.err} flexShrink={0} wrapMode="none">{wrapText(`inject failed: ${inject.reason}`, contentW).join("\n")}</text>
    ) : null;

  return (
    <Modal
      title={`error · ${errors.length} captured`}
      borderColor={theme.err}
      inset={{ top: "8%", right: "6%", bottom: "8%", left: "6%" }}
      hints={hints}
      fill
    >
      <WtScrollbox scrollRef={scrollRef}>
        <box flexShrink={0} flexDirection="column" marginBottom={1}>
          <text fg={theme.fgDim} wrapMode="none" flexShrink={0}>
            {wrapText("Captured instead of being printed over the panes; the full stack is also in the daily log.", contentW).join("\n")}
          </text>
          {isProcessDegraded() ? (
            <text fg={theme.warn} wrapMode="none" flexShrink={0}>
              {wrapText("an uncaughtException escaped the event loop: wt keeps running, but internal state may be inconsistent; restart when convenient", contentW).join("\n")}
            </text>
          ) : null}
          {injectLine}
        </box>
        {newestFirst.map((e, i) => (
          <ErrorBlock key={e.id} error={e} width={contentW} latest={i === 0} />
        ))}
        {errors.length === 0 ? (
          <text fg={theme.fgDim}>no captured errors</text>
        ) : null}
      </WtScrollbox>
    </Modal>
  );
}
