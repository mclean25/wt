import type { ReactNode } from "react";
import { useTerminalDimensions } from "@opentui/react";

import { KeyHint, type KeyHintPair } from "./key-hint.tsx";
import { theme } from "./theme.ts";

type Percent = `${number}%`;

type Inset = {
  top?: Percent;
  right?: Percent;
  bottom?: Percent;
  left?: Percent;
};

const DEFAULT_INSET: Required<Inset> = {
  top: "20%",
  right: "20%",
  bottom: "20%",
  left: "20%",
};

/**
 * Below this terminal width the viewport-relative insets stop making
 * sense — 20% of a narrow terminal leaves an unusably thin modal.
 * Narrow viewports get a full-width, near-full-height frame instead
 * (caller insets included: whatever margin looked right at 130 cols
 * is wrong at 35).
 */
const NARROW_WIDTH = 60;

const NARROW_INSET: Required<Inset> = {
  top: "5%",
  right: "0%",
  bottom: "5%",
  left: "0%",
};

type Props = {
  /** Title format: `name [· subtitle]`. Never include keystroke hints. */
  title: string;
  /**
   * Border + title color. Defaults to `theme.accent` (non-destructive).
   * Use `theme.warn` for confirm-before-irreversible-action modals.
   */
  borderColor?: string;
  /** Viewport-relative padding. Smaller values yield a larger modal. */
  inset?: Inset;
  /**
   * Keystroke hints rendered along the bottom edge. Pass an empty
   * array only if the modal has no dismiss path (it always has at
   * least one — esc/q/ctrl+c are universal).
   */
  hints: KeyHintPair[];
  /**
   * `true` pins the frame to the full inset-derived rectangle (the
   * pre-auto-height behavior) — for content that should OWN the space,
   * like the help overlay's scrolling sections. Default (false) sizes
   * the modal to its content, capped at that same rectangle.
   */
  fill?: boolean;
  children: ReactNode;
};

/**
 * Modal conventions every caller should follow:
 *
 *   1. **Toggle dismiss.** The key that opens the modal also closes it
 *      (e.g. `?` opens & closes help, `y` opens & closes the yank chord,
 *      `v` opens & closes the reviewer picker). Always accept it
 *      alongside the universal `esc` / `q` / `ctrl+c` dismiss keys, so
 *      muscle-memory works in both directions.
 *   2. **Universal dismiss.** Always accept `esc`, `q`, and `ctrl+c`.
 *   3. **Hints.** List dismiss keys in the `hints` prop so the user
 *      sees them along the bottom edge.
 */
export function Modal({
  title,
  borderColor = theme.accent,
  inset,
  hints,
  fill = false,
  children,
}: Props) {
  const { width, height } = useTerminalDimensions();
  const i =
    width < NARROW_WIDTH ? NARROW_INSET : { ...DEFAULT_INSET, ...inset };
  // Height is content-driven by default: the box grows with its
  // children and the vertical insets only bound the MAXIMUM. A seven-
  // row picker renders as a seven-row modal instead of a fixed
  // 60%-tall frame of mostly empty space. `fill` keeps the full frame
  // for content that owns the space (help's scrolling sections — a
  // bare flexGrow scrollbox doesn't self-measure, so auto-height
  // would collapse it).
  const maxHeight = Math.max(
    8,
    Math.floor((height * (100 - pct(i.top) - pct(i.bottom))) / 100),
  );
  return (
    <box
      position="absolute"
      top={i.top}
      left={i.left}
      right={i.right}
      {...(fill ? { bottom: i.bottom } : { maxHeight })}
      zIndex={10}
      backgroundColor={theme.bg}
      border
      borderStyle="double"
      borderColor={borderColor}
      title={` ${title} `}
      titleAlignment="left"
      padding={1}
      flexDirection="column"
    >
      <box
        flexDirection="column"
        flexShrink={1}
        minHeight={0}
        overflow="hidden"
        {...(fill ? { flexGrow: 1 } : {})}
      >
        {children}
      </box>
      {/* flexWrap: the hint chips flow onto extra rows at narrow widths
          instead of overrunning the border. Each chip is one unbreakable
          <text>; wrapping happens only between chips. */}
      <box flexShrink={0} flexDirection="row" flexWrap="wrap" marginTop={1}>
        <KeyHint pairs={hints} />
      </box>
    </box>
  );
}

function pct(p: Percent): number {
  const n = parseFloat(p);
  return Number.isFinite(n) ? n : 0;
}
