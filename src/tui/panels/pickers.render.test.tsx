import { expect, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { testRender } from "@opentui/react/test-utils";
import type { KeyEvent } from "@opentui/core";
import { StatusKind } from "../../core/types.ts";
import type { RemoteWorktreeSummary } from "../../core/remote-worktrees.ts";

import { handleConfirmKey } from "../modal-keys/confirm.ts";
import type { SimpleModalContext } from "../modal-keys/ctx.ts";
import { makeEdit } from "../text-edit.tsx";
import { ActionPickerModal, type PickerItem } from "./action-picker.tsx";
import { ConfirmModal } from "./confirm-modal.tsx";
import { CleanConfirmModal } from "./clean-confirm.tsx";
import { HarnessPickerModal } from "./harness-picker.tsx";
import { OutputsPicker } from "./outputs-picker.tsx";
import { ArgPickerModal, MultiPickerModal, PickerModal } from "./picker.tsx";
import { SectionPickerModal } from "./section-picker.tsx";
import { ScrollableList } from "./scroll-list.tsx";
import { SessionsPickerList, SessionsPickerNew, type PickerRow } from "./sessions-picker.tsx";

const longName = "長いブランチ 🚀 café feature-with-a-long-descriptive-name";
const branches = Array.from({ length: 20 }, (_, i) => `branch-${i} ${longName}`);

test("async candidate reorder keeps the same selected identity visible", async () => {
  let reorder = () => {};
  function Fixture() {
    const [items, setItems] = useState(["SELECTED", ...branches]);
    reorder = () => setItems([...branches, "SELECTED"]);
    return <box height={8}>
      <ScrollableList selectedId="SELECTED" revision={items}>
        {items.map((id) => <text key={id} id={id} height={1} flexShrink={0} wrapMode="none">{id}</text>)}
      </ScrollableList>
    </box>;
  }
  const setup = await render(<Fixture />, 40, 10);
  try {
    expect(setup.captureCharFrame()).toContain("SELECTED");
    act(reorder);
    await act(async () => { await setup.flush(); });
    await act(async () => { await setup.flush(); });
    expect(setup.captureCharFrame()).toContain("SELECTED");
  } finally { act(() => setup.renderer.destroy()); }
});

async function render(node: ReactNode, width: number, height: number) {
  const setup = await testRender(node, { width, height });
  await act(async () => { await setup.flush(); });
  await act(async () => { await setup.flush(); });
  return setup;
}

function expectClosedBorder(frame: string) {
  expect(frame.split("\n").some((line) => /^\s*╚═+╝\s*$/.test(line))).toBe(true);
}

test("long picker labels keep one row and selected item remains visible after resize", async () => {
  const setup = await render(
    <PickerModal title={`base · ${longName}`} items={branches} selectedIndex={12} toggleKey="b" />,
    120, 35,
  );
  try {
    for (const [width, height] of [[120, 35], [60, 20], [40, 16], [30, 10]]) {
      await act(async () => { setup.resize(width!, height!); await setup.flush(); });
      await act(async () => { await setup.flush(); });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("base ·");
      expect(frame).toContain("▸ branch-");
      const selected = setup.renderer.root.findDescendantById(`pick:${branches[12]}`)!;
      expect(selected.y).toBeGreaterThan(0);
      expect(selected.y).toBeLessThan(height! - 1);
      expect(frame).toContain("esc / q cancel");
      expectClosedBorder(frame);
      for (const branch of branches) {
        expect(setup.renderer.root.findDescendantById(`pick:${branch}`)?.height).toBe(1);
      }
    }
  } finally { act(() => setup.renderer.destroy()); }
});

test("reviewer selection and harness choice remain on one line in short terminals", async () => {
  const cases = [
    { kind: "reviewer", node: <MultiPickerModal title="reviewers" items={[{ key: "reviewer", label: longName }]} selectedIndex={0} checked={new Set(["reviewer"])} toggleKey="v" /> },
    { kind: "harness", node: <HarnessPickerModal slug={longName} selectedIndex={2} /> },
  ];
  for (const { kind, node } of cases) {
    const setup = await render(node, 80, 12);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("▸");
      expect(frame).toContain("esc / q cancel");
      expectClosedBorder(frame);
      if (kind === "harness") expect(frame).toContain("OpenCode");
      else expect(setup.renderer.root.findDescendantById("multi:reviewer")?.height).toBe(1);
    } finally { act(() => setup.renderer.destroy()); }
  }
});

test("action hints cannot overwrite the selected label or create wrapped rows", async () => {
  const items: PickerItem[] = [
    { kind: "devLogs", key: "l", availability: { ok: false, reason: "a lengthy missing prerequisite that must stay inside its column" } },
    { kind: "autoMerge", key: "m", armed: false, availability: { ok: true } },
    { kind: "custom" },
  ];
  const setup = await render(<ActionPickerModal slug={longName} surface="row" items={items} selectedIndex={0} />, 40, 16);
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toMatch(/▸ l Open/);
    expect(frame).toContain("(a le");
    for (const id of ["action:__dev-logs__", "action:__auto-merge__", "action:__custom__"]) {
      expect(setup.renderer.root.findDescendantById(id)?.height).toBe(1);
    }
    expectClosedBorder(frame);
  } finally { act(() => setup.renderer.destroy()); }
});

test("long session summaries do not consume the session list", async () => {
  const rows: PickerRow[] = Array.from({ length: 14 }, (_, i) => ({
    kind: "session", entry: {
      harnessId: "claude", sessionId: `id-${i}`, tmuxSessionName: `fixture-${i}`,
      displayName: `session-${i} ${longName}`, isLive: true, lastActiveMs: Date.now(),
      extras: { managedName: null, derivedState: "working", queued: 2 },
    },
  }));
  for (const [width, height] of [[120, 35], [40, 16], [30, 10]]) {
    const setup = await render(<SessionsPickerList slug={longName} rows={rows} selectedIndex={12} summaries={new Map([["id-12", { text: "A useful but lengthy summary. ".repeat(30) }]])} />, width!, height!);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("▸");
      expect(frame).toContain("esc / q cancel");
      expect(setup.renderer.root.findDescendantById("sess:claude:id-12")?.height).toBe(1);
      if (height! >= 24) {
        const summaryLines = frame.split("\n").filter((line) => line.includes("lengthy summary"));
        expect(summaryLines).toHaveLength(3);
        expect(summaryLines[2]).toContain("...");
      }
      expectClosedBorder(frame);
    } finally { act(() => setup.renderer.destroy()); }
  }
});

test("modal inputs retain the editing cursor after long Unicode values and resize", async () => {
  const input = makeEdit(longName.repeat(4));
  for (const node of [
    <ArgPickerModal title="Run action" prompt="A descriptive argument label" history={[]} index={0} input={input} />,
    <SectionPickerModal title="New section" items={[]} selectedIndex={0} newName={input} />,
  ]) {
    const setup = await render(node, 80, 20);
    try {
      await act(async () => { setup.resize(40, 16); await setup.flush(); });
      await act(async () => { await setup.flush(); });
      const frame = setup.captureCharFrame();
      expect(frame).toMatch(/[█▎]/);
      expect(frame).toContain("...");
      expect(frame).not.toContain("�");
      expectClosedBorder(frame);
    } finally { act(() => setup.renderer.destroy()); }
  }
});

test("output titles stay one row and empty picker states remain visible", async () => {
  const setup = await render(<OutputsPicker slug={longName} selectedIndex={0} items={[{ id: "output", kind: "action", title: longName, sessionName: null, status: "running", startedAt: 0, lastActivity: 0 }]} />, 40, 16);
  try {
    expect(setup.renderer.root.findDescendantById("out:output")?.height).toBe(1);
    expect(setup.captureCharFrame()).toContain("▸ 1 running");
  } finally { act(() => setup.renderer.destroy()); }
  const empty = await render(<OutputsPicker slug={null} items={[]} selectedIndex={0} />, 30, 10);
  try { expect(empty.captureCharFrame()).toContain("(no outputs)"); }
  finally { act(() => empty.renderer.destroy()); }
});

test("new session placeholder cannot consume the empty input cursor", async () => {
  for (const width of [30, 40]) {
    const setup = await render(<SessionsPickerNew slug="fixture" input={makeEdit("")} autoName="systematic-toucan" error={null} />, width, 35);
    try {
      const frame = setup.captureCharFrame();
      expect(frame).toContain("name █");
      expect(frame).toContain("systematic-");
      expect(frame).toContain("toucan)");
      expectClosedBorder(frame);
    } finally { act(() => setup.renderer.destroy()); }
  }
});

test("confirmation details can scroll without confirming, and y and Enter still confirm", async () => {
  const setup = await render(<ConfirmModal title="Remove worktree" message={longName} detail={`${"Context that must remain accessible. ".repeat(20)} FINAL HAZARD`} />, 40, 16);
  let closed = 0;
  const marked: string[] = [];
  const ctx = {
    setModal: () => closed++,
    doMarkReady: async (slug: string) => { marked.push(slug); },
  } as unknown as SimpleModalContext;
  const modal = { kind: "confirm", pendingKey: "e", slug: "fixture", title: "fixture", message: "fixture" } as const;
  try {
    expect(setup.captureCharFrame()).not.toContain("FINAL HAZARD");
    act(() => { handleConfirmKey({ name: "end" } as KeyEvent, modal, ctx); });
    await act(async () => { await setup.flush(); });
    expect(setup.captureCharFrame()).toContain("FINAL HAZARD");
    expect(closed).toBe(0);
    expect(marked).toEqual([]);
    expectClosedBorder(setup.captureCharFrame());
    handleConfirmKey({ name: "y" } as KeyEvent, modal, ctx);
    handleConfirmKey({ name: "return" } as KeyEvent, modal, ctx);
    await act(async () => { await setup.flush(); });
    expect(closed).toBe(2);
    expect(marked).toEqual(["fixture", "fixture"]);
    handleConfirmKey({ name: "escape" } as KeyEvent, modal, ctx);
    expect(closed).toBe(3);
    expect(marked).toHaveLength(2);
  } finally { act(() => setup.renderer.destroy()); }
});

test("short confirmation retains both cancel and scroll hints", async () => {
  const setup = await render(<ConfirmModal title="Remove" message={longName} detail={longName.repeat(3)} />, 30, 10);
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain("n / esc / q cancel");
    expect(frame).toContain("j/k scroll");
    expectClosedBorder(frame);
  } finally { act(() => setup.renderer.destroy()); }
});

test("narrow cleanup confirmation retains the candidate name and full hazard", async () => {
  const entry = {
    slug: "long-branch-with-critical-changes", hostKey: "fixture", hostLabel: "remote-host",
    status: { kind: StatusKind.Merged }, dirty: true,
  } as RemoteWorktreeSummary;
  const setup = await render(<CleanConfirmModal candidates={[{ kind: "remote", entry }]} />, 40, 20);
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain("long-branch-with-critical-");
    expect(frame).toContain("changes @ remote-host");
    expect(frame).toContain("uncommitted");
    expect(frame).toContain("changes");
    expect(frame).toContain("kept");
    expectClosedBorder(frame);
  } finally { act(() => setup.renderer.destroy()); }
});

test("the worktree palette shows the AI rename action", async () => {
  const setup = await render(
    <ActionPickerModal slug="selected" surface="row" selectedIndex={0}
      items={[{ kind: "renameWorktree", key: "t", availability: { ok: true } }, { kind: "custom" }]} />,
    90, 18,
  );
  try {
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Rename worktree with AI");
    expect(frame).toContain("▸ t");
  } finally { act(() => setup.renderer.destroy()); }
});
