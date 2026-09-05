import { describe, expect, test } from "bun:test";

import { remoteProvisioningCommands } from "./remote.ts";

describe("remoteProvisioningCommands", () => {
  test("provisions bundled skills and instructions before agent start", () => {
    expect(remoteProvisioningCommands(["agent", "start", "eng-1-fix"])).toEqual([
      ["skills", "sync", "--yes"],
    ]);
    expect(
      remoteProvisioningCommands([
        "agent",
        "--harness=codex",
        "start",
        "eng-1-fix",
      ]),
    ).toEqual([["skills", "sync", "--yes"]]);
  });

  test("does not provision for ordinary remote commands or prompt sends", () => {
    expect(remoteProvisioningCommands(["ls", "--json"])).toEqual([]);
    expect(
      remoteProvisioningCommands(["agent", "send", "eng-1-fix", "continue"]),
    ).toEqual([]);
  });
});
