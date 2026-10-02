import { describe, expect, test } from "bun:test";

import { parseHoldArgs } from "./hold.ts";

describe("resource hold command", () => {
  test("requires an original event, scope, deadline and owner", () => {
    const args = ["set", "browser:19989", "--scope", "browser navigation", "--at", "2026-10-02T18:40:00Z", "--until", "2026-10-02T19:00:00Z", "release when restart finishes"];
    expect(parseHoldArgs(args, "repair-owner")).toEqual({
      kind: "set", resource: "browser:19989", owner: "repair-owner",
      eventAt: "2026-10-02T18:40:00Z", until: "2026-10-02T19:00:00Z",
      scope: "browser navigation", reason: "release when restart finishes",
    });
    expect(parseHoldArgs(args, null)).toMatchObject({ kind: "error" });
    expect(parseHoldArgs(["set", "browser", "--until", "2026-10-02T19:00:00Z", "ack"], "manager")).toMatchObject({ kind: "error" });
    expect(parseHoldArgs([...args, "--at", "2026-10-02T19:11:00Z"], "manager")).toMatchObject({ kind: "error" });
  });

  test("an acknowledgment or release cannot silently turn into a fresh hold", () => {
    expect(parseHoldArgs(["ack", "browser"], "manager")).toMatchObject({ kind: "error" });
    expect(parseHoldArgs(["release", "browser", "--at", "2026-10-02T19:03:00Z", "--until", "2026-10-02T20:00:00Z", "ack"], "manager")).toMatchObject({ kind: "error" });
    expect(parseHoldArgs(["check", "old-id"], "manager")).toEqual({ kind: "check", value: "old-id" });
    expect(parseHoldArgs(["check", "old-id", "--at", "now"], "manager")).toMatchObject({ kind: "error" });
  });
});
