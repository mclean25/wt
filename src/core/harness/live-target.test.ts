import { describe, expect, test } from "bun:test";

import { chooseHarness } from "./live-target.ts";

const slugs = (...s: string[]) => new Set(s);
const live = (...n: string[]) => new Set(n);

describe("chooseHarness", () => {
  test("routes to the harness actually running, not the global primary", () => {
    // The reported failure: wt itself had started Codex in this
    // worktree; `send` read the one global Shift+Tab setting, said
    // claude, and cold-started a second session. Three fleet messages
    // landed in it and were lost when it was closed.
    expect(
      chooseHarness("brand-membership-rls", live(
        "brand-membership-rls-codex",
        "brand-membership-rls-dev",
        "brand-membership-rls-diff",
        "brand-membership-rls-shell",
      ), slugs("brand-membership-rls"), "claude"),
    ).toEqual({ harnessId: "codex", source: "live" });
  });

  test("falls back to the primary when nothing is live there", () => {
    // Right answer here: `send` is about to cold-start something, and
    // the primary is exactly "what to start".
    expect(chooseHarness("foo", live(), slugs("foo"), "codex")).toEqual({
      harnessId: "codex",
      source: "primary",
    });
  });

  test("a bare slug session is claude's", () => {
    expect(chooseHarness("foo", live("foo"), slugs("foo"), "codex")).toEqual({
      harnessId: "claude",
      source: "live",
    });
  });

  test("a named claude session counts as live", () => {
    expect(chooseHarness("foo", live("foo~review"), slugs("foo"), "codex")).toEqual({
      harnessId: "claude",
      source: "live",
    });
  });

  test("prefers the primary when several harnesses are live", () => {
    // That is where the human's own F12 would land.
    expect(
      chooseHarness("foo", live("foo", "foo-codex"), slugs("foo"), "codex"),
    ).toEqual({ harnessId: "codex", source: "live" });
    expect(
      chooseHarness("foo", live("foo", "foo-codex"), slugs("foo"), "claude"),
    ).toEqual({ harnessId: "claude", source: "live" });
  });

  test("a NEIGHBOUR worktree's claude session is not read as this slug's codex", () => {
    // `foo-codex` is both "foo's codex session" and "the worktree
    // foo-codex's claude session". The slug set is what separates
    // them; without it this is the strict-prefix trap again.
    expect(
      chooseHarness("foo", live("foo-codex"), slugs("foo", "foo-codex"), "claude"),
    ).toEqual({ harnessId: "claude", source: "primary" });
    // With no such worktree, the same name IS foo's codex session.
    expect(chooseHarness("foo", live("foo-codex"), slugs("foo"), "claude")).toEqual({
      harnessId: "codex",
      source: "live",
    });
  });

  test("an unanswerable tmux probe is distinguished from nothing running", () => {
    // Collapsing these is what routes a message to a fresh session
    // while the real one sits there — so `null` gets its own source
    // and the CLI says out loud that it could not check.
    expect(chooseHarness("foo", null, slugs("foo"), "claude")).toEqual({
      harnessId: "claude",
      source: "primary-unknown",
    });
  });
});
