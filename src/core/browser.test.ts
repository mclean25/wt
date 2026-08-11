/**
 * `ownsBrowserSession` and `sessionOnDevPort` are the boundary between
 * "wt closes a tab it opened" and "wt closes one of the user's tabs".
 * Cleanup runs unattended during a destroy or a dev-server stop, so a
 * miss here is silent — the browser just loses a tab nobody asked it to.
 */
import { describe, expect, test } from "bun:test";

import {
  browserSessionName,
  ownsBrowserSession,
  sessionOnDevPort,
} from "./browser.ts";

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

describe("sessionOnDevPort", () => {
  test("claims a loopback tab on the worktree's own dev port", () => {
    // The real shape: the session name is a login script's, not wt's,
    // which is exactly why the port rule has to exist.
    expect(sessionOnDevPort("http://localhost:8105/meetings", 8105)).toBe(true);
    expect(sessionOnDevPort("http://127.0.0.1:8105/", 8105)).toBe(true);
  });

  test("stops at a different port — one per worktree, and they are neighbours", () => {
    expect(sessionOnDevPort("http://localhost:8104/meetings", 8105)).toBe(false);
    // Prefix/suffix confusion is the failure that would close the wrong
    // worktree's tabs, so pin it in both directions.
    expect(sessionOnDevPort("http://localhost:81050/", 8105)).toBe(false);
    expect(sessionOnDevPort("http://localhost:810/", 8105)).toBe(false);
  });

  test("never claims a remote host that happens to use the port", () => {
    expect(sessionOnDevPort("https://app-staging.example.com:8105/", 8105)).toBe(false);
    expect(sessionOnDevPort("http://192.168.1.9:8105/", 8105)).toBe(false);
  });

  test("a session with no page, or an unparseable one, is never claimed", () => {
    expect(sessionOnDevPort(null, 8105)).toBe(false);
    expect(sessionOnDevPort("chrome-error://chromewebdata/", 8105)).toBe(false);
    expect(sessionOnDevPort("not a url", 8105)).toBe(false);
  });
});
