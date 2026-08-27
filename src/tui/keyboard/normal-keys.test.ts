import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";

import type { PullRequest } from "../../core/types.ts";
import { handleNormalKey, type NormalKeysCtx } from "./normal-keys.ts";

const plainKey = (name: string): KeyEvent =>
  ({
    name,
    sequence: name,
    raw: name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    number: false,
    eventType: "press",
    source: "raw",
  }) as KeyEvent;

test("p opens the selected remote worktree PR", () => {
  const opened: Array<{ url: string; number: number; logName: string }> = [];
  const remotePr = {
    url: "https://github.com/example/repo/pull/1515",
    number: 1515,
  } as PullRequest;
  const ctx = {
    focusedOutputId: null,
    consumePrTargetChord: () => false,
    handleGlobalKey: () => false,
    current: undefined,
    currentItem: undefined,
    selectedPr: undefined,
    selectedRemote: { hostLabel: "dellserver" },
    selectedRemotePr: remotePr,
    selectedSection: undefined,
    openPrUrl: (url: string, number: number, _target: null, logName: string) => {
      opened.push({ url, number, logName });
    },
  } as unknown as NormalKeysCtx;

  handleNormalKey(plainKey("p"), ctx);

  expect(opened).toEqual([
    {
      url: remotePr.url,
      number: remotePr.number,
      logName: "[remote:dellserver]",
    },
  ]);
});

test("l starts the Linear PR-target chord for a remote worktree", () => {
  const targets: string[] = [];
  const ctx = {
    focusedOutputId: null,
    consumePrTargetChord: () => false,
    handleGlobalKey: () => false,
    current: undefined,
    currentItem: undefined,
    selectedPr: undefined,
    selectedRemote: { hostLabel: "dellserver" },
    selectedRemotePr: { url: "https://github.com/example/repo/pull/1515", number: 1515 },
    selectedSection: undefined,
    rememberPrTargetChord: (target: string) => {
      targets.push(target);
      return true;
    },
  } as unknown as NormalKeysCtx;

  handleNormalKey(plainKey("l"), ctx);

  expect(targets).toEqual(["linear"]);
});

test("a folds Archived after archiving a remote worktree", async () => {
  const folds: Array<[string, boolean]> = [];
  const ctx = {
    focusedOutputId: null,
    consumePrTargetChord: () => false,
    handleGlobalKey: () => false,
    current: undefined,
    currentItem: undefined,
    selectedPr: undefined,
    selectedRemote: {
      hostKey: "ssh://dellserver/repo",
      hostLabel: "dellserver",
      slug: "remote-task",
    },
    selectedRemotePr: undefined,
    selectedSection: undefined,
    currentTarget: null,
    toggleArchived: async () => ({ archived: true }),
    setSectionFolded: async (key: string, folded: boolean) => {
      folds.push([key, folded]);
      return folded;
    },
    setSel: () => {},
    toast: () => {},
    reportActionError: (label: string, err: unknown) => {
      throw new Error(`${label}: ${String(err)}`);
    },
  } as unknown as NormalKeysCtx;

  handleNormalKey(plainKey("a"), ctx);
  await Promise.resolve();
  await Promise.resolve();

  expect(folds).toEqual([["\0archived", true]]);
});
