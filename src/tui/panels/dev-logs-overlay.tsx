/** Scrollable live supervisor output opened by `! l`. */
import { sanitizeLine } from "../../core/proc.ts";
import { useDevServerLog } from "../hooks/useDevServerLog.ts";
import { Modal } from "../modal.tsx";
import { useOverlayScroll, WtScrollbox } from "../scrollbox.tsx";
import { theme } from "../theme.ts";
import type { WorktreeTarget } from "../../core/worktree-target.ts";

/** Plain terminal rows for rendering; blank rows remain visible. */
export function devLogLines(output: string): string[] {
  return output.split("\n").map(sanitizeLine);
}

export function DevLogsOverlay({ slug, target }: { slug: string; target?: WorktreeTarget }) {
  const output = useDevServerLog(slug, target);
  const scrollRef = useOverlayScroll();
  const lines = output === null ? [] : devLogLines(output);
  return (
    <Modal
      title={`dev logs · ${slug}`}
      inset={{ top: "8%", right: "10%", bottom: "8%", left: "10%" }}
      maxWidth={null}
      hints={[
        ["j k / ↑ ↓", "scroll"],
        ["g / G", "top / bottom"],
        ["l / esc / q", "close"],
      ]}
      fill
    >
      <WtScrollbox scrollRef={scrollRef} stickyScroll stickyStart="bottom">
        {lines.length === 0 ? (
          <text fg={theme.fgDim}>waiting for dev server output…</text>
        ) : (
          lines.map((line, i) => (
            <box key={i} flexShrink={0} overflow="hidden">
              <text fg={theme.fg} wrapMode="none" truncate>
                {line || " "}
              </text>
            </box>
          ))
        )}
      </WtScrollbox>
    </Modal>
  );
}
