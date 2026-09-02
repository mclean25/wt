/**
 * React error boundary around the whole app tree — the third capture
 * origin next to the process-level handlers in `error-store.ts`. A
 * render/commit error unmounts the app, so the modal-based overlay
 * can't show it; instead the boundary records it in the same ring
 * (ring + `log.error`, never stdout/stderr) and renders a minimal
 * full-screen crash view with its own tiny key handler: `r` retries
 * the render (state that caused the crash may have moved on), `y`
 * copies the error, `q`/`Ctrl+C` quits through the normal exit path so
 * runtime.tsx's teardown still runs.
 */
import { Component, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";

import { writeClipboardPromise } from "../core/macos.ts";
import {
  captureError,
  formatCapturedError,
  latestCapturedError,
  useCapturedErrors,
} from "./error-store.ts";
import {
  handleOverlayScrollKey,
  useOverlayScroll,
  WtScrollbox,
} from "./scrollbox.tsx";
import { theme } from "./theme.ts";
import type { TuiExit } from "./app.tsx";

function CrashScreen({
  onRetry,
  onExit,
}: {
  onRetry: () => void;
  onExit: (e: TuiExit) => void;
}) {
  // Subscribe, don't snapshot: React renders this fallback BEFORE
  // componentDidCatch records the crash into the ring (reconciler
  // ordering), so a bare latestCapturedError() here would paint
  // empty/stale on the exact crash it exists to show. The subscription
  // re-renders when the ring catches up.
  useCapturedErrors();
  const captured = latestCapturedError();
  // The app tree is unmounted here, so this useKeyboard is the only
  // handler left — the shared overlay scroll keymap keeps the crash
  // screen's j/k feel identical to the live overlays.
  const scrollRef = useOverlayScroll();
  useKeyboard((k) => {
    if (handleOverlayScrollKey(k)) return;
    if (k.name === "q" || (k.ctrl && k.name === "c")) {
      onExit({ kind: "quit" });
      return;
    }
    if (k.name === "r" && !k.ctrl && !k.meta) {
      onRetry();
      return;
    }
    if (k.name === "y" && !k.ctrl && !k.meta && captured) {
      try {
        writeClipboardPromise(formatCapturedError(captured));
      } catch {
        // Nowhere safe to report from here; the log has the error.
      }
    }
  });
  return (
    <box
      flexDirection="column"
      flexGrow={1}
      backgroundColor={theme.bg}
      padding={2}
    >
      <text fg={theme.err} attributes={1}>
        wt UI crashed while rendering
      </text>
      <text fg={theme.fgDim} wrapMode="word">
        The error was captured (full stack in the daily log). r retry
        render · y copy error · q quit
      </text>
      <box marginTop={1} flexDirection="column" flexGrow={1} overflow="hidden">
        <WtScrollbox scrollRef={scrollRef}>
          {(captured?.stack ?? "no captured error").split("\n").map((line, i) => (
            <text key={i} fg={i === 0 ? theme.fgBright : theme.fg} wrapMode="word">
              {line}
            </text>
          ))}
        </WtScrollbox>
      </box>
    </box>
  );
}

type Props = { onExit: (e: TuiExit) => void; children: ReactNode };
type State = { crashed: boolean };

export class TuiErrorBoundary extends Component<Props, State> {
  override state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  override componentDidCatch(error: unknown): void {
    // Ring + daily log; never stdout/stderr — the renderer still owns
    // the terminal even though the app tree just died. Guarded: a
    // poisoned error object throwing here would crash the boundary
    // that exists to contain it.
    try {
      captureError("render", error);
    } catch {
      // Nothing safe left to do with it.
    }
  }

  override render(): ReactNode {
    if (this.state.crashed) {
      return (
        <CrashScreen
          onRetry={() => this.setState({ crashed: false })}
          onExit={this.props.onExit}
        />
      );
    }
    return this.props.children;
  }
}
