import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { captureError } from "../error-store.ts";
import { overlayScroll } from "../scrollbox.tsx";
import { ErrorOverlay } from "./error-overlay.tsx";

test("narrow error stacks retain every Unicode character and path segment", async () => {
  const message = "日本語".repeat(12) + "終端";
  const path = "/a/very/long/file/name/with/repeated/subfolders/" + "directory/".repeat(8) + "final.ts:10:5";
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ${path}`;
  captureError("render", error);
  const setup = await testRender(<ErrorOverlay inject={{ kind: "idle" }} />, { width: 120, height: 50 });
  try {
    for (const width of [120, 35, 60, 120]) {
      act(() => setup.resize(width, 50));
      await act(async () => { await setup.flush(); });
      const frame = setup.captureCharFrame();
      const content = frame.split("\n")
        .map((line) => line.slice(line.indexOf("║") + 1, line.lastIndexOf("║")).trim())
        .join("").replaceAll(" ", "");
      expect(content).toContain(`Error:${message}`);
      expect(content).toContain(path);
    }
    act(() => setup.resize(35, 12));
    await act(async () => { await setup.flush(); });
    act(() => overlayScroll.current?.scrollTo(10000));
    await act(async () => { await setup.flush(); });
    expect(setup.captureCharFrame()).toContain(".ts:10:5");
    expect(setup.captureCharFrame()).toContain("dismiss");
  } finally {
    act(() => setup.renderer.destroy());
  }
});
