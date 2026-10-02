/**
 * Pick-an-AI-harness modal. Opened by Shift+F12 as a one-off override
 * of the primary harness for the next spawn. Mirrors the trigger-key
 * confirm + j/k + digits + per-harness letter shortcut pattern shared
 * across every list-picker in the TUI.
 *
 * Per-harness letters come from each impl's `letter` field — `c` for
 * Claude, `o` for OpenCode, `x` for Codex. Pressing the letter jumps
 * the highlight to that row; Shift+F12 (re-press, the trigger-key
 * convention), bare F12, or Enter then confirms.
 */
import { VISIBLE_HARNESSES } from "../../core/harness/index.ts";
import { Modal } from "../modal.tsx";
import { ScrollableList } from "./scroll-list.tsx";
import { theme } from "../theme.ts";

type Props = {
  slug: string;
  selectedIndex: number;
};

export function HarnessPickerModal({ slug, selectedIndex }: Props) {
  const items = VISIBLE_HARNESSES;
  return (
    <Modal
      title={`pick harness · ${slug}`}
      inset={{ top: "30%", right: "30%", bottom: "30%", left: "30%" }}
      hints={[
        ["j/k", "move"],
        // The visible harness list is always ≤9 entries, so digits are
        // unconditionally live — see handleListPickerKey's default.
        ["1-9", "quick pick"],
        ["c / o / x", "jump"],
        ["⇧F12 / F12 / ⏎", "spawn"],
        ["esc / q", "cancel"],
      ]}
    >
      <ScrollableList selectedId={`harness:${items[selectedIndex]?.id}`}>
        {items.map((h, i) => {
          const selected = i === selectedIndex;
          const bg = selected ? theme.rowSelectedBg : undefined;
          return (
            <box
              key={h.id}
              id={`harness:${h.id}`}
              flexDirection="row"
              backgroundColor={bg}
              paddingLeft={1}
              paddingRight={1}
              height={1}
              flexShrink={0}
              overflow="hidden"
            >
              <text width="100%" height={1} wrapMode="none" truncate fg={selected ? theme.fgBright : theme.fg}>
                <span fg={selected ? theme.accent : theme.fgDim}>
                  {selected ? "▸ " : "  "}
                </span>
                <span fg={theme.fgDim}>{h.letter} </span>
                <span fg={h.color}>{h.glyph}  </span>
                {h.label}
              </text>
            </box>
          );
        })}
      </ScrollableList>
    </Modal>
  );
}
