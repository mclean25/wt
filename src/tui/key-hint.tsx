import type { ReactNode } from "react";

import { theme } from "./theme.ts";

export type KeyHintPair = [key: string, label: string];

type Props = {
  pairs: KeyHintPair[];
  separator?: string;
};

/**
 * Inline keystroke hint, e.g. `j/k move · ⏎ pick · esc cancel`.
 * Returns a Fragment of `<text>` nodes so the caller controls the
 * row container (typically `<box flexDirection="row">`).
 *
 * Each `key + label (+ separator)` chip is a single non-wrapping
 * `<text>`, so a `flexWrap="wrap"` container breaks the row BETWEEN
 * chips at narrow widths — never mid-hint, and never through the
 * modal border.
 */
export function KeyHint({ pairs, separator = " · " }: Props) {
  const parts: ReactNode[] = [];
  pairs.forEach(([key, label], i) => {
    parts.push(
      <text key={`h-${i}`} wrapMode="none">
        <span fg={theme.accent} attributes={1}>
          {key}
        </span>
        <span fg={theme.fgDim}> {label}</span>
        {i < pairs.length - 1 ? <span fg={theme.fgDim}>{separator}</span> : null}
      </text>,
    );
  });
  return <>{parts}</>;
}
