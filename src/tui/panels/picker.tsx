import type { HistoryEntry } from "../../core/actions.ts";
import type { KeyHintPair } from "../key-hint.tsx";
import { Modal } from "../modal.tsx";
import { editSpans, type TextEdit } from "../text-edit.tsx";
import { ScrollableList } from "./scroll-list.tsx";
import { theme } from "../theme.ts";

type Props = {
  title: string;
  items: string[];
  selectedIndex: number;
  /**
   * Key that opens the modal — re-pressing it confirms (chord-confirm
   * convention; see modal UX rules in AGENTS.md). Shown in the "pick"
   * hint when set.
   */
  toggleKey?: string;
  /**
   * Per-item chord letters, rendered dim before each label (`null` for
   * chordless rows). Same length as `items` when provided.
   */
  itemKeys?: readonly (string | null)[];
  /**
   * Per-item glyph column (e.g. the work-status dot in the exact color
   * the list pane uses), rendered between the chord and the label so
   * the picker doubles as the legend for those glyphs. `null` rows keep
   * the column width blank.
   */
  itemGlyphs?: readonly ({ glyph: string; color: string } | null)[];
  /** Picker-specific hints, slotted between "pick" and "cancel". */
  extraHints?: readonly KeyHintPair[];
};

export function PickerModal({
  title,
  items,
  selectedIndex,
  toggleKey,
  itemKeys,
  itemGlyphs,
  extraHints,
}: Props) {
  const pickKeys = toggleKey ? `${toggleKey} / ⏎` : "⏎";
  // Digits are live by default whenever the list has ≤9 rows
  // (list-picker.ts's `handleListPickerKey`) — surface the hint so
  // quick-pick isn't invisible.
  const showDigits = items.length <= 9;
  // A digit column would crowd the letter-chord column (statusPicker's
  // `itemKeys`), so only render it when rows don't already carry a
  // chord; chorded pickers keep the hint text without the column.
  const showDigitColumn = showDigits && !itemKeys;
  const hints: KeyHintPair[] = [["j/k", "move"]];
  if (showDigits) hints.push(["1-9", "quick pick"]);
  hints.push([pickKeys, "pick"]);
  if (extraHints) hints.push(...extraHints);
  hints.push(["esc / q", "cancel"]);
  return (
    <Modal title={title} hints={hints}>
      <ScrollableList
        selectedId={items[selectedIndex] ? `pick:${items[selectedIndex]}` : undefined}
        revision={items}
      >
        {items.map((item, i) => {
          const selected = i === selectedIndex;
          const bg = selected ? theme.rowSelectedBg : undefined;
          const fg = selected ? theme.fgBright : theme.fg;
          const chord = itemKeys?.[i] ?? null;
          const digit = showDigitColumn && i < 9 ? `${i + 1}` : null;
          return (
            <box
              id={`pick:${item}`}
              key={item}
              flexDirection="row"
              backgroundColor={bg}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={selected ? theme.accent : theme.fgDim}>
                {selected ? "▸ " : "  "}
              </text>
              {showDigitColumn ? (
                <text fg={selected ? theme.accent : theme.fgDim}>
                  {digit ? `${digit} ` : "  "}
                </text>
              ) : null}
              {itemKeys ? (
                <text fg={selected ? theme.accent : theme.fgDim}>
                  {chord ? `${chord} ` : "  "}
                </text>
              ) : null}
              {itemGlyphs ? (
                itemGlyphs[i] ? (
                  // Two trailing spaces: Nerd Font dots draw wider than
                  // their single cell, so one space reads as glyph-glued-
                  // to-label. Null rows pad the same 3 cells to stay
                  // aligned.
                  <text fg={itemGlyphs[i]!.color}>{`${itemGlyphs[i]!.glyph}  `}</text>
                ) : (
                  <text>{"   "}</text>
                )
              ) : null}
              <text fg={fg} wrapMode="none" truncate>
                {item}
              </text>
            </box>
          );
        })}
      </ScrollableList>
    </Modal>
  );
}

export type MultiPickerItem = {
  /** Stable identity used for selection set membership. */
  key: string;
  /** Primary text shown for the item. */
  label: string;
  /** Optional dim suffix (e.g. "(requested)"). */
  hint?: string;
};

type MultiProps = {
  title: string;
  items: MultiPickerItem[];
  selectedIndex: number;
  checked: ReadonlySet<string>;
  /**
   * Key that opens the modal — re-pressing it submits (chord-confirm
   * convention; see modal UX rules in AGENTS.md). Shown in the
   * "submit" hint when set.
   */
  toggleKey?: string;
};

export function MultiPickerModal({
  title,
  items,
  selectedIndex,
  checked,
  toggleKey,
}: MultiProps) {
  const submitKeys = toggleKey ? `${toggleKey} / ⏎` : "⏎";
  return (
    <Modal
      title={title}
      hints={[
        ["j/k", "move"],
        ["space", "toggle"],
        [submitKeys, "submit"],
        ["esc / q", "cancel"],
      ]}
    >
      {items.length === 0 ? (
        <text fg={theme.fgDim}>no candidates</text>
      ) : null}
      <ScrollableList
        selectedId={items[selectedIndex] ? `multi:${items[selectedIndex]!.key}` : undefined}
        revision={items}
      >
        {items.map((item, i) => {
          const cursor = i === selectedIndex;
          const isChecked = checked.has(item.key);
          const bg = cursor ? theme.rowSelectedBg : undefined;
          const fg = cursor ? theme.fgBright : theme.fg;
          const box = isChecked ? "[x]" : "[ ]";
          const boxFg = isChecked ? theme.ok : theme.fgDim;
          return (
            <box
              id={`multi:${item.key}`}
              key={item.key}
              flexDirection="row"
              backgroundColor={bg}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={cursor ? theme.accent : theme.fgDim}>
                {cursor ? "▸ " : "  "}
              </text>
              <text fg={boxFg}>{box} </text>
              <text fg={fg} wrapMode="none" truncate>
                {item.label}
                {item.hint ? (
                  <span fg={theme.fgDim}> {item.hint}</span>
                ) : null}
              </text>
            </box>
          );
        })}
      </ScrollableList>
    </Modal>
  );
}

type ArgProps = {
  title: string;
  prompt: string;
  history: readonly HistoryEntry[];
  /**
   * Cursor index across `history.length + 1` rows — the trailing slot
   * is the "new value" affordance that opens the input on confirm.
   */
  index: number;
  /**
   * When non-null, the picker is in input mode (typing a fresh value).
   * The text field replaces the list footer.
   */
  input: TextEdit | null;
};

/**
 * Action-arg picker: shows recent values for one action with an
 * optional human label (sourced via the action's `label_extract` regex
 * against the run's captured output — see `core/actions/history.ts`).
 * The trailing
 * row, "+ new value...", drops into a single-line input. Empty history
 * skips straight to input mode at the call site, so this list never
 * renders as just the "+ new" row alone.
 *
 * Modal UX rules: Enter / Esc only (no chord — reached mid-`!` flow,
 * see AGENTS.md "When a picker doesn't naturally have a single trigger
 * key").
 */
export function ArgPickerModal({
  title,
  prompt,
  history,
  index,
  input,
}: ArgProps) {
  if (input !== null) {
    return (
      <Modal
        title={title}
        hints={[
          ["⏎", "launch"],
          ["esc", "back"],
          ["^C", "cancel"],
        ]}
      >
        <box flexDirection="row" paddingLeft={1} paddingRight={1}>
          <text fg={theme.accent} attributes={1}>{prompt}</text>
          <text fg={theme.fg}> </text>
          <text>{editSpans(input, theme.fgBright)}</text>
        </box>
      </Modal>
    );
  }
  const rows: Array<{ label: string; hint?: string; isNew: boolean }> = [];
  for (const entry of history) {
    rows.push({
      label: entry.label ?? entry.value,
      hint: entry.label ? entry.value : undefined,
      isNew: false,
    });
  }
  rows.push({ label: "+ new value…", isNew: true });
  // Digits quick-pick history rows only (the "+ new" row is Enter-only
  // — see handleArgPickerKey), so gate the hint on history size, not
  // the full row count.
  const showDigits = history.length > 0 && history.length <= 9;
  const listHints: KeyHintPair[] = [["j/k", "move"]];
  if (showDigits) listHints.push(["1-9", "quick pick"]);
  listHints.push(["⏎", "pick"], ["esc / q", "cancel"]);
  return (
    <Modal title={title} hints={listHints}>
      <ScrollableList selectedId={`arg:${index}`} revision={rows.length}>
        {rows.map((row, i) => {
          const selected = i === index;
          const bg = selected ? theme.rowSelectedBg : undefined;
          const labelFg = row.isNew ? theme.accent : (selected ? theme.fgBright : theme.fg);
          return (
            <box
              id={`arg:${i}`}
              key={`${i}-${row.label}`}
              flexDirection="row"
              backgroundColor={bg}
              paddingLeft={1}
              paddingRight={1}
            >
              <text fg={selected ? theme.accent : theme.fgDim}>
                {selected ? "▸ " : "  "}
              </text>
              <text fg={labelFg} wrapMode="none" truncate>
                {row.label}
                {row.hint ? <span fg={theme.fgDim}> · {row.hint}</span> : null}
              </text>
            </box>
          );
        })}
      </ScrollableList>
    </Modal>
  );
}
