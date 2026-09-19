import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { KeyEvent } from "@opentui/core";
import { handleGlobalKey, type GlobalKeysCtx } from "./global-keys.ts";

test("Ctrl+Shift+A clears queued automations rather than toggling pause", async () => {
  let cleared = 0;
  let toggled = 0;
  const messages: string[] = [];
  const ctx = {
    automations: {
      configured: true,
      togglePaused: async () => { toggled++; return true; },
      clearQueued: () => Effect.sync(() => { cleared++; return 2; }),
    },
    toast: (message: string) => messages.push(message),
    reportActionError: () => { throw new Error("unexpected failure"); },
  } as unknown as GlobalKeysCtx;
  expect(handleGlobalKey({ name: "a", sequence: "\u001b[97;6u", ctrl: true, shift: true } as KeyEvent, ctx)).toBe(true);
  await Promise.resolve();
  expect(cleared).toBe(1);
  expect(toggled).toBe(0);
  expect(messages).toEqual(["cleared 2 queued automations"]);
});
