/**
 * `ownsBrowserSession` and `urlOnDevPort` are the boundary between "wt
 * closes a tab it opened" and "wt closes one of the user's tabs".
 * Cleanup runs unattended during a destroy or a dev-server stop, so a
 * miss here is silent — the browser just loses a tab nobody asked it to.
 *
 * `urlOnDevPort` carries more weight than its size suggests: it is the
 * sole gate on the AppleScript sweep, which closes tabs the browser
 * itself reports, with no browser-control session vouching for them.
 */
import { describe, expect, test } from "bun:test";

import { browserSessionName, ownsBrowserSession, urlOnDevPort } from "./browser.ts";

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

describe("urlOnDevPort", () => {
  test("claims a loopback tab on the worktree's own dev port", () => {
    // The real shape: the session name is a login script's, not wt's,
    // which is exactly why the port rule has to exist.
    expect(urlOnDevPort("http://localhost:8105/meetings", 8105)).toBe(true);
    expect(urlOnDevPort("http://127.0.0.1:8105/", 8105)).toBe(true);
    expect(urlOnDevPort("http://[::1]:8105/", 8105)).toBe(true);
    // A dev server behind local TLS is still the worktree's.
    expect(urlOnDevPort("https://localhost:8105/", 8105)).toBe(true);
    // Query and hash live past the path; the host:port decides.
    expect(urlOnDevPort("http://localhost:8105/deep/path?q=1#x", 8105)).toBe(true);
    // Bare origin, no trailing slash — what a human types.
    expect(urlOnDevPort("http://localhost:8105", 8105)).toBe(true);
  });

  test("stops at a different port — one per worktree, and they are neighbours", () => {
    expect(urlOnDevPort("http://localhost:8104/meetings", 8105)).toBe(false);
    // Prefix/suffix confusion is the failure that would close the wrong
    // worktree's tabs, so pin it in both directions.
    expect(urlOnDevPort("http://localhost:81050/", 8105)).toBe(false);
    expect(urlOnDevPort("http://localhost:810/", 8105)).toBe(false);
  });

  test("never claims a remote host that happens to use the port", () => {
    expect(urlOnDevPort("https://app-staging.example.com:8105/", 8105)).toBe(false);
    expect(urlOnDevPort("http://192.168.1.9:8105/", 8105)).toBe(false);
    // Parsing, not substring matching: the loopback origin appearing
    // inside a remote URL must not hand wt someone else's tab.
    expect(urlOnDevPort("https://evil.test/?next=http://localhost:8105/", 8105)).toBe(false);
    expect(urlOnDevPort("https://localhost.evil.test:8105/", 8105)).toBe(false);
  });

  test("the browser's own pages are never claimed", () => {
    // The sweep reads every tab the browser has, so these arrive for
    // real — unlike the session path, which only ever saw pageUrls.
    expect(urlOnDevPort("chrome://newtab/", 8105)).toBe(false);
    expect(urlOnDevPort("chrome-error://chromewebdata/", 8105)).toBe(false);
    expect(urlOnDevPort("about:blank", 8105)).toBe(false);
  });

  test("a session with no page, or an unparseable one, is never claimed", () => {
    expect(urlOnDevPort(null, 8105)).toBe(false);
    expect(urlOnDevPort("", 8105)).toBe(false);
    expect(urlOnDevPort("not a url", 8105)).toBe(false);
  });
});
