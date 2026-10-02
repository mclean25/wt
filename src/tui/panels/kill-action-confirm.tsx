import { Modal } from "../modal.tsx";
import { theme } from "../theme.ts";
import { ConfirmBody } from "./confirm-body.tsx";

type Props = {
  slug: string;
  actionName: string;
};

export function KillActionConfirmModal({ slug, actionName }: Props) {
  return (
    <Modal
      title="kill action"
      borderColor={theme.warn}
      inset={{ top: "30%", right: "25%", bottom: "30%", left: "25%" }}
      hints={[
        ["y", "kill"],
        ["! / n / esc / q", "cancel"],
        ["j/k", "scroll"],
      ]}
    >
      <ConfirmBody>
        <text flexShrink={0} fg={theme.fg}>
          Kill{" "}
          <span fg={theme.warn} attributes={1}>
            {actionName}
          </span>{" "}
          on{" "}
          <span fg={theme.accent}>{slug}</span>
          ?
        </text>
        <box flexShrink={0} marginTop={1} flexDirection="column">
          <text fg={theme.fgDim} wrapMode="word">
            The Claude process gets SIGTERM. Any in-progress git/SST
            commands it spawned can keep running until they finish.
          </text>
        </box>
      </ConfirmBody>
    </Modal>
  );
}
