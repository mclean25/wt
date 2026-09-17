import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { readTerminalPaletteConfig, saveTerminalPalette, terminalPalette, terminalPaletteConfig } from "./palette.ts";

const colors = { defaultForeground: "#CDD6F4", defaultBackground: "#1E1E2E" };

describe("observed terminal palette", () => {
  test("validates exact RGB colors and ignores unrelated renderer fields", () => {
    expect(terminalPalette({ ...colors, palette: [] })).toEqual({ defaultForeground: "#cdd6f4", defaultBackground: "#1e1e2e" });
    for (const value of [null, {}, { ...colors, defaultBackground: null }, { ...colors, defaultForeground: "red" }, { ...colors, defaultBackground: "#123456; run-shell evil" }, { ...colors, defaultBackground: "#123" }]) {
      expect(terminalPalette(value)).toBeNull();
      expect(terminalPaletteConfig(value)).toBe("");
    }
  });

  test("sets defaults only, leaving explicit pane and window overrides intact", () => {
    expect(terminalPaletteConfig(colors)).toBe("set -g window-style 'fg=#cdd6f4,bg=#1e1e2e'\nset -g window-active-style 'fg=#cdd6f4,bg=#1e1e2e'\n");
  });

  test("persists observations, preserves last known colors on timeout, ignores corrupt cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-palette-test-"));
    try {
      expect(readTerminalPaletteConfig(dir)).toBe("");
      expect(await Effect.runPromise(saveTerminalPalette(dir, colors))).toBe(true);
      expect(readTerminalPaletteConfig(dir)).toBe(terminalPaletteConfig(colors));
      expect(await Effect.runPromise(saveTerminalPalette(dir, { defaultForeground: null, defaultBackground: null }))).toBe(false);
      expect(readTerminalPaletteConfig(dir)).toBe(terminalPaletteConfig(colors));
      writeFileSync(join(dir, "terminal-palette.json"), "broken");
      expect(readTerminalPaletteConfig(dir)).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test.skipIf(!Bun.which("tmux") || !Bun.which("python3"))("detached tmux answers OSC default-color queries only with observed defaults", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-palette-osc-"));
  const script = join(dir, "probe.py");
  const socket = join(dir, "socket");
  writeFileSync(script, `import os, sys, tty, select, time
tty.setraw(0)
os.write(1, b'\\x1b]10;?\\x07\\x1b]11;?\\x07')
reply = b''
deadline = time.monotonic() + 0.4
while time.monotonic() < deadline:
    if select.select([0], [], [], max(0, deadline - time.monotonic()))[0]:
        reply += os.read(0, 4096)
with open(sys.argv[1], 'w') as output:
    output.write(reply.hex())
`);
  const tmux = async (...args: string[]) => {
    const proc = Bun.spawn(["tmux", "-S", socket, ...args], { stdout: "pipe", stderr: "pipe" });
    const [exit, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { exit, stderr };
  };
  try {
    for (const [label, palette] of [["unknown", ""], ["known", terminalPaletteConfig(colors)]] as const) {
      const config = join(dir, `${label}.conf`);
      const output = join(dir, `${label}.out`);
      writeFileSync(config, `set -g default-terminal tmux-256color\n${palette}`);
      const result = await tmux("-f", config, "new-session", "-d", "-s", label, `python3 ${script} ${output}`);
      expect(result.exit).toBe(0);
      const deadline = Date.now() + 5000;
      while (!existsSync(output) && Date.now() < deadline) await Bun.sleep(25);
      expect(existsSync(output)).toBe(true);
      const reply = Buffer.from(readFileSync(output, "utf8"), "hex").toString();
      if (label === "unknown") expect(reply).toBe("");
      else {
        expect(reply).toContain("10;rgb:cdcd/d6d6/f4f4");
        expect(reply).toContain("11;rgb:1e1e/1e1e/2e2e");
      }
      await tmux("kill-server");
    }
  } finally {
    await tmux("kill-server");
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
