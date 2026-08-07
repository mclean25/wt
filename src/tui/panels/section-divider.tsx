/**
 * Section divider shared by every panel that groups rows under a
 * labeled rule — the classic worktree list (`panels/list.tsx`) and the
 * task inbox (`panels/tasks.tsx`) rendered byte-identical copies of
 * this before it was factored out here; keep it that way rather than
 * letting either panel drift its own version.
 */
import { theme } from "../theme.ts";

/**
 * One style for every section — manual sections, auto-managed stack
 * sections, and task-inbox buckets all share the same muted rule + label.
 * An optional identity glyph belongs to the group itself (for example an SSH
 * server); row status still stays on each row.
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
  // Leave room for padding (border+paddingLeft+paddingRight roughly 4
  // cells) so the rule doesn't bleed past the panel edge.
  const inner = Math.max(0, width - 4);
  const labelStr = ` ${label} `;
  const iconCells = icon ? 3 : 0;
  const padding = Math.max(0, inner - labelStr.length - iconCells - 2);
  const trail = "─".repeat(padding);
  // The trail is sized for the full width, but when the list overflows the
  // vertical scrollbar steals a column, making the row one cell too wide.
  // Flex layout absorbs that: the `──` prefix is pinned (`flexShrink={0}`),
  // while the label and trail sit in `overflow="hidden"` boxes that shrink —
  // so the stolen column clips a `─` off the (much wider) trail, and the
  // label's `truncate` only ever ellipsises its TAIL, never eating the
  // leading space after `──`. height={1} + wrapMode="none" keep it one line.
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
      <box flexShrink={1} overflow="hidden">
        <text fg={theme.fgDim} wrapMode="none" truncate>
          {icon ? `${label} ` : labelStr}
        </text>
      </box>
      <box flexShrink={1} overflow="hidden">
        <text fg={theme.borderDim} wrapMode="none">{trail}</text>
      </box>
    </box>
  );
}
