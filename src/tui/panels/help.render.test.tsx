import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { makeEdit } from "../text-edit.tsx";
import { HelpOverlay } from "./help.tsx";

test("help keeps flag descriptions readable when a two-column block narrows", async () => {
  const setup = await testRender(<HelpOverlay query={makeEdit("prompt flags")} searching={false} />, { width: 120, height: 24 });
  try {
    for (const width of [120, 35, 60, 120]) {
      act(() => setup.resize(width, 24));
      await act(async () => { await setup.flush(); });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("match any author");
      expect(frame).toContain("branch off <ref>");
      expect(frame).toContain("esc clear");
    }
  } finally {
    act(() => setup.renderer.destroy());
  }
});

test("long help search stays on one row with a visible cursor", async () => {
  const setup = await testRender(<HelpOverlay query={makeEdit("a long unmatched 日本語 search ending")} searching />, { width: 35, height: 16 });
  try {
    await act(async () => { await setup.flush(); });
    await act(async () => { await setup.flush(); });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("ending▌");
    expect(frame).toContain("no matches");
    expect(frame).toContain("esc cancel");
  } finally {
    act(() => setup.renderer.destroy());
  }
});
