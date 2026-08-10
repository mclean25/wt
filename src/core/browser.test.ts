/**
 * `ownsBrowserSession` is the boundary between "wt closes a tab it
 * opened" and "wt closes one of the user's tabs". Cleanup runs
 * unattended during a destroy, so a miss here is silent — the browser
 * just loses a tab nobody asked it to.
 */
import { describe, expect, test } from "bun:test";

import { browserSessionName, ownsBrowserSession } from "./browser.ts";

describe("ownsBrowserSession", () => {
  test("claims the slug's own session", () => {
    expect(ownsBrowserSession("eng-1-slug", browserSessionName("eng-1-slug"))).toBe(true);
  });

  test("claims a suffixed second context", () => {
    expect(ownsBrowserSession("eng-1-slug", "wt-eng-1-slug-login")).toBe(true);
  });

  test("stops at the separator — a slug is not a prefix of its neighbours", () => {
    expect(ownsBrowserSession("foo", "wt-foobar")).toBe(false);
    expect(ownsBrowserSession("eng-1", "wt-eng-12")).toBe(false);
  });

  test("never claims a session outside wt's namespace", () => {
    // The names in the wild: agent-chosen and relay-generated.
    for (const id of ["czlogin8100", "perfqa", "calm-badger-919", "eng-1-slug"]) {
      expect(ownsBrowserSession("eng-1-slug", id)).toBe(false);
    }
  });

  test("never claims another worktree's session", () => {
    expect(ownsBrowserSession("eng-1-slug", browserSessionName("eng-2-other"))).toBe(false);
  });
});
