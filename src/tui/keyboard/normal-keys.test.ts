import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";

import type { PullRequest } from "../../core/types.ts";
import type { WorktreeModel } from "../worktree-model.ts";
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

function remoteModel(pr?: PullRequest, archived = false): WorktreeModel {
  const target = {
    ref: { kind: "remote", host: "dellserver", slug: "remote-task" },
    slug: "remote-task",
    branch: "alex/remote-task",
    path: "/remote/remote-task",
    stage: "remote-task",
    location: {
      kind: "remote",
      endpoint: { host: "dellserver", label: "Dell server", wtPath: "~/bin/wt" },
    },
  } as const;
  return {
    target,
    source: { kind: "remote", row: { hostLabel: "dellserver" } },
    key: "remote:dellserver:remote-task",
    slug: target.slug,
    pr,
    archived,
  } as WorktreeModel;
}

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
    selectedWorktree: remoteModel(remotePr),
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
      logName: "remote-task",
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
    selectedWorktree: remoteModel(),
    selectedSection: undefined,
    rememberPrTargetChord: (target: string) => {
      targets.push(target);
      return true;
    },
    openSectionPicker: () => {},
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
    selectedWorktree: remoteModel(),
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
  await Bun.sleep(0);

  expect(folds).toEqual([["\0archived", true]]);
});

test("a restores a remote worktree to Inbox through the shared mutation", async () => {
  const sections: Array<[string, string | null]> = [];
  const model = remoteModel(undefined, true);
  const ctx = {
    focusedOutputId: null,
    consumePrTargetChord: () => false,
    handleGlobalKey: () => false,
    current: undefined,
    currentItem: undefined,
    selectedPr: undefined,
    selectedRemote: { hostLabel: "dellserver", slug: model.slug },
    selectedWorktree: model,
    selectedSection: undefined,
    toggleArchived: async () => ({ archived: false }),
    setWorktreeSection: async (target: WorktreeModel["target"], section: string | null) => {
      sections.push([target.slug, section]);
    },
    setSel: () => {},
    toast: () => {},
    reportActionError: (label: string, err: unknown) => {
      throw new Error(`${label}: ${String(err)}`);
    },
  } as unknown as NormalKeysCtx;

  handleNormalKey(plainKey("a"), ctx);
  await Bun.sleep(0);

  expect(sections).toEqual([["remote-task", null]]);
});

test("! opens the same action picker for a remote worktree", () => {
  const opened: unknown[] = [];
  const target = {
    ref: { kind: "remote", host: "dellserver", slug: "remote-task" },
    slug: "remote-task",
    branch: "alex/remote-task",
    path: "/remote/remote-task",
    stage: "remote-task",
    location: {
      kind: "remote",
      endpoint: { host: "dellserver", label: "Dell server", wtPath: "~/bin/wt" },
    },
  } as const;
  const ctx = {
    focusedOutputId: null,
    consumePrTargetChord: () => false,
    handleGlobalKey: () => false,
    current: undefined,
    currentItem: undefined,
    currentTarget: target,
    selectedPr: undefined,
    selectedRemote: { hostLabel: "Dell server" },
    selectedRemotePr: undefined,
    selectedWorktree: remoteModel(),
    selectedSection: undefined,
    openActionPicker: (picked: unknown) => opened.push(picked),
  } as unknown as NormalKeysCtx;

  handleNormalKey({ ...plainKey("!"), sequence: "!" } as KeyEvent, ctx);

  expect(opened).toEqual([target]);
});
