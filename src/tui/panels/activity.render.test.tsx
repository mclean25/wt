import { expect, test } from "bun:test";
import { act } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";

import { events } from "../activity-log.ts";
import { OutputViewer } from "./output-viewer.tsx";

function SplitFixture() {
  const { width } = useTerminalDimensions();
  return (
    <box flexDirection="row">
      <box width={52} flexShrink={0} />
      <OutputViewer output={{ id: "events", kind: "events", title: "attention", status: "live", sessionName: null, startedAt: 1, lastActivity: 1 }} height={20} width={width - 52} />
    </box>
  );
}

test("wide event sources cannot consume message cells or wrap the timestamp", async () => {
  const message = "FAILED: deployment stopped because required credentials were missing. Retry only after updating the configuration.";
  const ts = Date.now();
  events.seed([{ ts, channel: "attention", level: "err", source: "日本語の長い作業名です", text: message }]);
  const setup = await testRender(<SplitFixture />, { width: 120, height: 20 });
  try {
    for (const width of [120, 132, 97, 82, 72, 132]) {
      act(() => setup.resize(width, 20));
      await setup.flush();
      const frame = setup.captureCharFrame();
      expect(frame).toContain(new Date(ts).toTimeString().slice(0, 8));
      const lines = frame.split("\n").map((line) => line.slice(52)).filter((line) => line.startsWith("│"))
        .map((line) => line.slice(1, -1).trim()).filter(Boolean);
      // The message begins on the timestamp row, then spans continuation
      // rows. Joining them must recover every word, including edge words.
      const text = lines.join("").replaceAll(" ", "");
      const start = text.indexOf("FAILED:");
      expect(text).toContain("FAILED:");
      // At 20 cells the final long word is hard-wrapped; compare characters
      // without spaces so those intentional word splits do not hide loss.
      expect(text.slice(start)).toBe(message.replaceAll(" ", ""));
    }
  } finally {
    act(() => setup.renderer.destroy());
  }
});
