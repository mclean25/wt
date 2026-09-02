import { useEffect } from "react";
import { CliRenderEvents } from "@opentui/core";
import { useRenderer } from "@opentui/react";

import { createLogger } from "../../core/logger.ts";
import { pluralize } from "../../core/text.ts";
import { writeClipboard } from "../../core/macos.ts";
import { forkReported } from "../effect-boundary.ts";

const log = createLogger("app");

type SelectionLike = { getSelectedText(): string };

function extractSelection(selection: unknown): string | null {
  if (
    selection &&
    typeof selection === "object" &&
    typeof (selection as SelectionLike).getSelectedText === "function"
  ) {
    try {
      return (selection as SelectionLike).getSelectedText() || null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Auto-copy-on-select. Subscribes to the renderer's `selection` event,
 * which fires once per drag when the user releases the mouse. Copies
 * the selected text to the system clipboard, clears the highlight, and
 * logs to the activity pane.
 */
export function useAutoCopy(): void {
  const renderer = useRenderer();
  useEffect(() => {
    if (!renderer) return;
    const handler = (selection: unknown): void => {
      const text = extractSelection(selection);
      if (!text) return;
      forkReported(writeClipboard(text), (error) => {
        log.event.err(`pbcopy failed: ${error.message}`);
      });
      renderer.clearSelection();
      const lines = text.split("\n").length;
      const suffix = lines > 1 ? ` (${pluralize(lines, "line")})` : "";
      log.event.info(`copied ${pluralize(text.length, "char")}${suffix}`);
    };
    renderer.on(CliRenderEvents.SELECTION, handler);
    return () => {
      renderer.off(CliRenderEvents.SELECTION, handler);
    };
  }, [renderer]);
}
