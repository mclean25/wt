import { expect, test } from "bun:test";
import { hideTerminalCommand } from "./zed.ts";

test("terminal hiding is disabled with an empty opt-in list", () => {
  expect(hideTerminalCommand([])).toBeNull();
});

test("terminal process names are arguments, never AppleScript source", () => {
  const apps = ["Ghostty", "custom terminal", 'quote" and \\ slash', "--help"];
  const command = hideTerminalCommand(apps)!;
  expect(command.slice(command.indexOf("--") + 1)).toEqual(apps);
  expect(command).toContain("ignoring case");
  expect(command).toContain("if name of p is in terminalApps then set visible of p to false");
  expect(command.slice(0, command.indexOf("--")).join("\n")).not.toContain("Ghostty");
});

test.skipIf(process.platform !== "darwin")("AppleScript receives names literally and matches case-insensitively", () => {
  for (const [apps, expected] of [[['gHoStTy', 'quote" \\ name'], "true"], [["other terminal"], "false"]] as const) {
    const command = hideTerminalCommand(apps)!.map((arg) => {
      if (arg === "set p to first application process whose frontmost is true") return 'set candidateName to "Ghostty"';
      if (arg === "if name of p is in terminalApps then set visible of p to false") return "return candidateName is in terminalApps";
      return arg;
    });
    const result = Bun.spawnSync(command);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(expected);
  }
});
