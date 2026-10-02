import { expect, test } from "bun:test";
import type { KeyEvent } from "@opentui/core";
import { handleRemovedViewKey, type RemovedViewKeysCtx } from "./removed-view-keys.ts";

test("history details accept Ctrl+J/K and legacy linefeed without moving the list", () => {
  const scrolled: number[] = [];
  const selected: number[] = [];
  const ctx = {
    handleGlobalKey: () => false,
    removedEntries: [{ slug: "one" }, { slug: "two" }],
    removedCursor: 0,
    setRemovedIndex: (index: number) => selected.push(index),
    detailsScrollRef: { current: { scrollBy: (delta: number) => scrolled.push(delta) } },
  } as unknown as RemovedViewKeysCtx;
  for (const key of [
    { name: "j", ctrl: true },
    { name: "k", ctrl: true },
    { name: "linefeed" },
  ]) {
    handleRemovedViewKey(key as KeyEvent, ctx);
  }
  expect(scrolled).toEqual([3, -3, 3]);
  expect(selected).toEqual([]);
  handleRemovedViewKey({ name: "j" } as KeyEvent, ctx);
  expect(selected).toEqual([1]);
});
