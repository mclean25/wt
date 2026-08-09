import {
  issueIdForSlug,
  issueUrlForSlug,
  specificIssueUrl,
} from "../../core/issue-tracker.ts";
import { stageUrl } from "../../core/stage.ts";
import { Modal } from "../modal.tsx";
import { ScrollableList } from "./scroll-list.tsx";
import { theme } from "../theme.ts";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";

export type Item = { key: string; label: string; value: string | null };

type Props = { row: WorktreeRow; selectedIndex: number };

/**
 * `padEnd` budget for the label column, one char past the longest
 * label ("stage url", 9) so there's always a gap before the value.
 */
const LABEL_WIDTH = 10;

/**
 * Items the `y` chord can yank. Order matches their key letters; the
 * modal renders this list verbatim. A null `value` shows as a dim "—"
 * and committing it (Enter/digit/chord) errors with a "nothing to
 * yank" toast instead of copying the placeholder.
 */
export function yankItemsFor(row: WorktreeRow): Item[] {
  const stageUrlValue =
    row.fields.deploy.data === true ? stageUrl(row.wt.stage) : null;
  const dev = row.fields.dev.data;
  const prUrlValue = row.pr ? row.pr.url : null;
  return [
    { key: "b", label: "branch", value: row.wt.branch || null },
    { key: "s", label: "stage", value: row.wt.stage },
    { key: "S", label: "stage url", value: stageUrlValue },
    { key: "d", label: "dev url", value: dev?.running ? dev.url : null },
    { key: "p", label: "path", value: row.wt.path },
    { key: "n", label: "slug", value: row.wt.slug },
    // `i` mirrors the open key: most specific first (attached GitHub
    // issue, else tracker URL, else the bare parsed id). `I` is always
    // the primary tracker issue.
    {
      key: "i",
      label: "issue",
      value:
        specificIssueUrl(row.wt.slug, row.githubIssue) ??
        issueIdForSlug(row.wt.slug),
    },
    {
      key: "I",
      label: "primary",
      value: issueUrlForSlug(row.wt.slug) ?? issueIdForSlug(row.wt.slug),
    },
    { key: "r", label: "pr url", value: prUrlValue },
  ];
}

/** Index of the first row with a real value, for the modal's initial cursor. */
export function firstYankIndex(items: readonly Item[]): number {
  const i = items.findIndex((it) => it.value !== null);
  return i === -1 ? 0 : i;
}

export function YankModal({ row, selectedIndex }: Props) {
  const items = yankItemsFor(row);
  return (
    <Modal
      title="yank · pick what to copy"
      inset={{ top: "25%", right: "20%", bottom: "20%", left: "20%" }}
      hints={[
        ["j/k", "move"],
        ["1-9", "quick pick"],
        ["letter", "direct"],
        ["y / ⏎", "pick"],
        ["esc / q", "cancel"],
      ]}
    >
      <ScrollableList
        selectedId={items[selectedIndex] ? `yank:${items[selectedIndex]!.key}` : undefined}
        revision={items}
      >
        {items.map((it, i) => {
          const selected = i === selectedIndex;
          const bg = selected ? theme.rowSelectedBg : undefined;
          return (
            <box
              id={`yank:${it.key}`}
              key={it.key}
              flexDirection="row"
              backgroundColor={bg}
              paddingLeft={1}
              paddingRight={1}
            >
              {/* Cursor + chord + label as one text node (spans, padEnd
                  alignment), wrapped in a flexShrink={0} box so it
                  never gives up width to the value column — without
                  it, long values pressure the row and eat the padEnd
                  padding first (row-cell.tsx's Row applies the same
                  flexShrink={0} to its label box for the same reason).
                  Only the value gets flexShrink/overflow="hidden" —
                  the part that must clip instead of pushing the row
                  wider than the modal. */}
              <box flexShrink={0}>
                <text wrapMode="none">
                  <span fg={selected ? theme.accent : theme.fgDim}>
                    {selected ? "▸ " : "  "}
                  </span>
                  <span fg={theme.accent} attributes={1}>
                    {it.key.padEnd(2)}
                  </span>
                  <span fg={selected ? theme.fgBright : theme.fg}>
                    {it.label.padEnd(LABEL_WIDTH)}
                  </span>
                </text>
              </box>
              <box flexShrink={1} overflow="hidden">
                <text fg={theme.fgDim} wrapMode="none" truncate>
                  {it.value ?? "—"}
                </text>
              </box>
            </box>
          );
        })}
      </ScrollableList>
    </Modal>
  );
}
