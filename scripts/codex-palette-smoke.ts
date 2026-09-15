/** bun scripts/codex-palette-smoke.ts
 * Actual installed Codex, detached private tmux servers, no model requests.
 * Checks composer shading after palette discovery at detached startup.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminalPaletteConfig } from "../src/core/tmux/palette.ts";

for (const executable of ["codex", "tmux"]) {
  if (!Bun.which(executable)) throw new Error(`${executable} must be installed on PATH`);
}
const scratch = mkdtempSync(join(tmpdir(), "wt-palette-smoke-"));
const palette = { defaultForeground: "#cdd6f4", defaultBackground: "#1e1e2e" };

async function probe(name: string, configured: boolean) {
  const home = join(scratch, name);
  mkdirSync(home);
  const socket = join(home, "socket");
  const config = join(home, "tmux.conf");
  writeFileSync(config, "set -g status off\nset -g default-terminal tmux-256color\n" + (configured ? terminalPaletteConfig(palette) : ""));
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TERM: "xterm-256color" };
  async function tmux(...args: string[]) {
    const proc = Bun.spawn(["tmux", "-S", socket, "-f", config, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`private tmux ${args[0]}: ${stderr}`);
    return stdout;
  }
  try {
    await tmux("new-session", "-d", "-x", "120", "-y", "40", "-s", "probe", "codex", "-C", home, "--no-alt-screen",
      "-c", 'model_provider="probe"', "-c", 'model_providers.probe.name="probe"',
      "-c", 'model_providers.probe.base_url="http://127.0.0.1:1/v1"',
      "-c", 'model_providers.probe.wire_api="responses"', "-c", 'model="probe"');
    let screen = "";
    let trusted = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      screen = await tmux("capture-pane", "-p", "-e", "-t", "probe");
      if (screen.includes("Yes, continue") && !trusted) {
        await tmux("send-keys", "-t", "probe", "Enter");
        trusted = true;
      }
      if (screen.includes("probe default")) break;
      await Bun.sleep(100); // Real detached process startup.
    }
    if (!screen.includes("probe default")) throw new Error(`${name}: composer never initialized: ${screen}`);
    const composer = screen.split("\n").find(line => line.includes("Ask Codex"));
    if (!composer) throw new Error(`${name}: composer missing: ${screen}`);
    const backgrounds = [...composer.matchAll(/\x1b\[([^m]*?(?:48;2;\d+;\d+;\d+)[^m]*)m/g)].map(match => match[1]!);
    console.log(`${name}: composer backgrounds ${JSON.stringify(backgrounds)}; ${JSON.stringify(composer)}`);
    if (configured && backgrounds.length === 0) throw new Error("Configured palette did not produce composer RGB shading");
    if (configured && backgrounds.every(value => value.includes("48;2;30;30;46"))) throw new Error("Composer has only the terminal default background, not contrasting shading");
    if (!configured && backgrounds.length !== 0) throw new Error("Baseline unexpectedly has composer RGB shading");
  } finally {
    // Never addresses the live wt server. Killing this server closes only its probe.
    await Bun.spawn(["tmux", "-S", socket, "kill-server"], { env, stdout: "ignore", stderr: "ignore" }).exited;
  }
}

try {
  const version = Bun.spawn(["codex", "--version"], { stdout: "pipe" });
  console.log((await new Response(version.stdout).text()).trim());
  await version.exited;
  await probe("baseline", false);
  await probe("palette", true);
  console.log("PASS detached startup palette enables composer shading. No live sessions or model requests used.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
