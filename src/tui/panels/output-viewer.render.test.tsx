import { expect, test } from "bun:test";
import { act } from "react";
import { useTerminalDimensions } from "@opentui/react";
import { testRender } from "@opentui/react/test-utils";

import type { Output } from "../../core/outputs.ts";
import { OutputViewer } from "./output-viewer.tsx";

function SplitFixture({ output }: { output: Output }) {
  const { width } = useTerminalDimensions();
  return <box flexDirection="row"><box width={52} flexShrink={0} /><OutputViewer output={output} height={8} width={width - 52} /></box>;
}

test("long action border titles keep the outcome visible through terminal resize", async () => {
  const output: Output = {
    id: "fixture", kind: "action",
    title: "A very long action name 日本語の詳細説明 deploy all required services",
    status: "failed", sessionName: null, startedAt: 1, lastActivity: 1,
  };
  const setup = await testRender(<SplitFixture output={output} />, { width: 120, height: 10 });
  try {
    for (const width of [120, 132, 97, 82, 72, 132]) {
      act(() => setup.resize(width, 10));
      await setup.flush();
      const title = setup.captureCharFrame().split("\n")[0]!.slice(52);
      expect(title).toContain(" · failed ");
      expect(title).toContain("...");
      expect(Bun.stringWidth(title)).toBeLessThanOrEqual(width - 52);
    }
  } finally {
    act(() => setup.renderer.destroy());
  }
});
