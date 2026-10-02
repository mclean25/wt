/**
 * Section divider for every panel that groups rows under a labeled
 * rule (the worktree list's manual and stack sections).
 */
import { theme } from "../theme.ts";
import { truncateEnd } from "../text.ts";

/**
 * One style for every section — manual sections and auto-managed stack
 * sections share the same muted rule + label. An optional identity
 * glyph belongs to the group itself (for example an SSH server); row
 * status still stays on each row.
 */
export function Divider({
  label,
  width,
  icon,
}: {
  label: string;
  width: number;
  /** Optional group identity glyph. Status still belongs on each row. */
  icon?: { glyph: string; fg: string };
}) {
  // Borders, row padding, and the scrollbox's reserved gutter consume
  // five cells. Measure the label in cells so a wide section name keeps
  // its space instead of being squeezed by an over-long trailing rule.
  const inner = Math.max(0, width - 5);
  const iconCells = icon ? Bun.stringWidth(` ${icon.glyph} `) : 0;
  const labelStr = truncateEnd(icon ? `${label} ` : ` ${label} `, Math.max(0, inner - iconCells - 2));
  const padding = Math.max(0, inner - Bun.stringWidth(labelStr) - iconCells - 2);
  const trail = "─".repeat(padding);
  // The label already fits its cell budget; any residual layout pressure
  // should shorten the decorative rule first. Keep the row to one line.
  return (
    <box flexDirection="row" height={1} paddingLeft={1} paddingRight={1}>
      <box flexShrink={0}>
        <text fg={theme.borderDim} wrapMode="none">──</text>
      </box>
      {icon ? (
        <box flexShrink={0}>
          <text fg={icon.fg} wrapMode="none">{` ${icon.glyph} `}</text>
        </box>
      ) : null}
      <box flexShrink={0} overflow="hidden">
        <text fg={theme.fgDim} wrapMode="none">
          {labelStr}
        </text>
      </box>
      <box flexShrink={1} overflow="hidden">
        <text fg={theme.borderDim} wrapMode="none">{trail}</text>
      </box>
    </box>
  );
}
