import { describe, expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { setImmediate as settle } from "node:timers/promises";

import { handleFooterInputKey, type FooterInputKeysCtx } from "../keyboard/footer-input-keys.ts";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";
import type { FooterMode } from "../panels/footer.tsx";
import { makeEdit } from "../text-edit.tsx";
import { makeWorktreeTitleFlows } from "./worktree-title.ts";

const key = (name: string) => ({ name, sequence: name, ctrl: false }) as KeyEvent;

function setup(options: { save?: (slug: string, title: string) => Promise<void>; live?: boolean } = {}) {
  let footer: FooterMode = { kind: "legend" };
  const writes: Array<[string, string]> = [];
  const messages: string[] = [];
  const setFooter: FooterInputKeysCtx["setFooter"] = (next) => {
    footer = typeof next === "function" ? next(footer) : next;
  };
  const current = { wt: { slug: "repair-launch" }, title: "AI-generated title" } as WorktreeRow;
  const flows = makeWorktreeTitleFlows({
    current,
    setFooter,
    setManualTitle: async (slug, title) => {
      writes.push([slug, title]);
      await options.save?.(slug, title);
    },
    isSlugLive: () => options.live ?? true,
    toast: (message) => messages.push(message),
  });
  function input() {
    if (footer.kind !== "input") throw new Error("expected input");
    return footer;
  }
  function press(name: string) {
    handleFooterInputKey(key(name), {
      footer: input(),
      setFooter,
      setPendingRename: () => {},
      setPendingStatusText: () => {},
      setPendingIssueSlug: () => {},
      pendingRename: null,
      renameSection: async () => {},
      setLastMoveTarget: () => {},
      toast: (message) => messages.push(message),
      doNew: async () => false,
      doRemoteNew: async () => false,
      pendingStatusText: null,
      commitStatusText: () => {},
      pendingIssueSlug: null,
      commitIssueId: () => {},
      commitWorktreeTitle: flows.commitWorktreeTitle,
    });
  }
  return { flows, current, input, press, setFooter, writes, messages, footer: () => footer };
}

describe("worktree title editor", () => {
  test("prefills the displayed title and Enter saves the unchanged AI title", async () => {
    const ui = setup();
    ui.flows.openWorktreeTitlePrompt();
    expect(ui.input().edit).toEqual(makeEdit("AI-generated title"));
    ui.press("return");
    await settle();
    expect(ui.writes).toEqual([["repair-launch", "AI-generated title"]]);
    expect(ui.footer()).toEqual({ kind: "legend" });
    expect(ui.messages).toContain("title saved; automatic naming disabled");
  });

  test("keeps whitespace-only input open without writing", async () => {
    const ui = setup();
    ui.flows.openWorktreeTitlePrompt();
    ui.setFooter({ ...ui.input(), edit: makeEdit("  ") });
    const submitted = ui.input();
    ui.press("return");
    await settle();
    expect(ui.footer()).toBe(submitted);
    expect(ui.writes).toEqual([]);
    expect(ui.messages).toEqual(["enter a title; Esc cancels"]);
  });

  test("Esc cancels without writing", async () => {
    const ui = setup();
    ui.flows.openWorktreeTitlePrompt();
    ui.press("escape");
    await settle();
    expect(ui.footer()).toEqual({ kind: "legend" });
    expect(ui.writes).toEqual([]);
  });

  test("targets the captured slug if the selected row changes during editing", async () => {
    const ui = setup();
    ui.flows.openWorktreeTitlePrompt();
    ui.current.wt.slug = "different-row";
    ui.setFooter({ ...ui.input(), edit: makeEdit("  Keep this title  ") });
    ui.press("return");
    await settle();
    expect(ui.writes).toEqual([["repair-launch", "Keep this title"]]);
  });

  test("does not create title state for a removed row", async () => {
    const ui = setup({ live: false });
    ui.flows.openWorktreeTitlePrompt();
    ui.press("return");
    await settle();
    expect(ui.writes).toEqual([]);
    expect(ui.messages).toEqual(["repair-launch is gone; title not written"]);
  });

  test("restores the typed title after a failed save", async () => {
    const ui = setup({ save: async () => { throw new Error("disk unavailable"); } });
    ui.flows.openWorktreeTitlePrompt();
    ui.setFooter({ ...ui.input(), edit: makeEdit("Keep this title") });
    const submitted = ui.input();
    ui.press("return");
    await settle();
    expect(ui.footer()).toBe(submitted);
    expect(ui.messages[0]).toContain("disk unavailable");
  });

  test("a failed save cannot overwrite a later footer interaction", async () => {
    const { promise: saved, reject } = Promise.withResolvers<void>();
    const ui = setup({ save: () => saved });
    ui.flows.openWorktreeTitlePrompt();
    ui.press("return");
    await settle();
    const later: FooterMode = { kind: "input", prompt: "new:", edit: makeEdit("new-task"), purpose: "new" };
    ui.setFooter(later);
    reject(new Error("disk unavailable"));
    await settle();
    expect(ui.footer()).toBe(later);
  });
});
