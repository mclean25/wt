import type { SessionKind } from "../../core/tmux.ts";
import type { KeyHintPair } from "../key-hint.tsx";
import { Modal } from "../modal.tsx";
import { theme } from "../theme.ts";

type Props = {
  slug: string;
  /** Which session kind is being killed — drives the body copy. */
  sessionKind: Exclude<SessionKind, "action" | "dev">;
};

const COPY: Record<Props["sessionKind"], { title: string; body: string }> = {
  claude: {
    title: "Kill the interactive Claude session on",
    body:
      "The tmux session and the running Claude process are " +
      "terminated. Conversation history is preserved on disk, " +
      "next F12 resumes the same conversation. Use /clear inside " +
      "Claude if you want a fresh context.",
  },
  codex: {
    title: "Kill the Codex session on",
    body:
      "The tmux session and the running Codex process are " +
      "terminated. The session rollout is preserved on disk; " +
      "resume it from the picker via `codex resume`.",
  },
  opencode: {
    title: "Kill the OpenCode session on",
    body:
      "The tmux session and the running OpenCode process are " +
      "terminated. The session is preserved in opencode.db; " +
      "resume it from the picker.",
  },
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
  // The harness variants (claude/codex/opencode) open via `x` on a
  // live session row and toggle-dismiss on it; shell/diff open via
  // Shift+F10/F11 chords with no single re-pressable key, so they
  // fall back to the universal cancels only.
  const isHarness =
    sessionKind === "claude" || sessionKind === "codex" || sessionKind === "opencode";
  const hints: KeyHintPair[] = [["y", "kill"]];
  if (isHarness) hints.push(["x", "cancel"]);
  hints.push(["n / esc / q", "cancel"]);
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
