import type { SessionKind } from "../../core/tmux.ts";
import type { KeyHintPair } from "../key-hint.tsx";
import { Modal } from "../modal.tsx";
import { theme } from "../theme.ts";

type Props = {
  slug: string;
  /** Which session kind is being killed — drives the body copy. */
  sessionKind: Extract<SessionKind, "shell" | "diff">;
};

// Harness sessions (Claude/Codex) kill DIRECTLY from the
// sessions picker's `x` — no confirm — so only the Shift+F10/F11
// shell/diff chords route through this modal.
const COPY: Record<Props["sessionKind"], { title: string; body: string }> = {
  diff: {
    title: "Kill the diff session on",
    body:
      "The tmux session and the diff TUI are terminated. Next F11 " +
      "opens a fresh session, scroll position and expanded hunks " +
      "won't carry over.",
  },
  shell: {
    title: "Kill the shell session on",
    body:
      "The tmux session and the shell, including any background " +
      "processes you launched in it, are terminated. Next F10 " +
      "starts a fresh shell.",
  },
};

export function KillSessionConfirmModal({ slug, sessionKind }: Props) {
  const copy = COPY[sessionKind];
  // Shell/diff open via Shift+F10/F11 chords with no single
  // re-pressable key, so they use the universal cancels only.
  const hints: KeyHintPair[] = [
    ["y", "kill"],
    ["n / esc / q", "cancel"],
  ];
  return (
    <Modal
      title="kill session"
      borderColor={theme.warn}
      inset={{ top: "30%", right: "25%", bottom: "30%", left: "25%" }}
      hints={hints}
    >
      <box flexDirection="column">
        <text fg={theme.fg}>
          {copy.title} <span fg={theme.accent}>{slug}</span>
          ?
        </text>
        <box marginTop={1} flexDirection="column">
          <text fg={theme.fgDim} wrapMode="word">
            {copy.body}
          </text>
        </box>
      </box>
    </Modal>
  );
}
