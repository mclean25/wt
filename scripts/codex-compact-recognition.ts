/** Manual integration smoke: bun scripts/codex-compact-recognition.ts
 * Uses the installed Codex TUI, isolated homes, and an unreachable local provider.
 * Proves command recognition, not successful model-backed compaction.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compactMessages } from "../src/core/harness/compact.ts";
import { MANAGER_BUILTIN_ACTIONS } from "../src/core/actions/builtins.ts";
import { applyVars } from "../src/core/actions/template.ts";

if (!Bun.which("codex")) throw new Error("codex must be installed on PATH");
const scratch = mkdtempSync(join(tmpdir(), "wt-compact-recognition-"));
const stripAnsi = (value: string) => value
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

async function probe(name: string, command: string, native: boolean) {
  const home = join(scratch, name);
  mkdirSync(home);
  let output = "";
  const child = Bun.spawn([
    "codex", "-C", home, "--no-alt-screen",
    "-c", 'model_provider="probe"',
    "-c", 'model_providers.probe.name="probe"',
    "-c", 'model_providers.probe.base_url="http://127.0.0.1:1/v1"',
    "-c", 'model_providers.probe.wire_api="responses"',
    "-c", "model_providers.probe.request_max_retries=0",
    "-c", "model_providers.probe.stream_max_retries=0",
    "-c", 'model="probe"',
  ], {
    // Deliberately do not inherit credentials, socket addresses, or user config.
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TERM: "xterm-256color" },
    terminal: {
      cols: 120, rows: 40,
      data(_terminal, data) { output += Buffer.from(data).toString(); },
    },
  });
  const terminal = child.terminal!;
  async function waitFor(predicate: () => boolean, label: string) {
    const deadline = Date.now() + 15000;
    while (!predicate()) {
      if (child.exitCode !== null) throw new Error(`${name}: Codex exited (${child.exitCode}) waiting for ${label}: ${stripAnsi(output).slice(-3000)}`);
      if (Date.now() > deadline) throw new Error(`${name}: timed out waiting for ${label}: ${stripAnsi(output).slice(0, 2000)}`);
      await Bun.sleep(50); // Real PTY/OS integration, not a simulated clock.
    }
  }
  const compactDispatch = () => {
    try {
      const db = new Database(join(home, "logs_2.sqlite"), { readonly: true });
      try {
        return Number((db.query("select count(*) as count from logs where target='codex_core::session::handlers' and feedback_log_body like '%op: Compact%'").get() as { count: number }).count);
      } finally { db.close(); }
    } catch { return 0; } // Log database can appear after startup.
  };
  try {
    await waitFor(() => stripAnsi(output).includes("Yes, continue") || stripAnsi(output).includes("probe default"), "trust/composer");
    if (stripAnsi(output).includes("Yes, continue")) terminal.write("\r");
    await waitFor(() => stripAnsi(output).includes("probe default"), "initialized composer");
    output = "";
    // Match wt's tmux paste-buffer -p transport, followed by a separate Enter.
    terminal.write(`\x1b[200~${command}\x1b[201~`);
    await waitFor(() => stripAnsi(output).includes(command), "typed command");
    // Separate input writes avoid Codex's paste-burst newline heuristic.
    await Bun.sleep(200);
    terminal.write("\r");
    if (native) {
      await waitFor(() => compactDispatch() > 0, "native Compact dispatch");
      console.log("PASS bare /compact: installed Codex dispatched native Compact");
    } else {
      await waitFor(() => stripAnsi(output).includes("Working"), "ordinary user turn");
      if (compactDispatch() !== 0) throw new Error("Inline-argument negative control unexpectedly dispatched Compact");
      console.log("PASS /compact focus negative control: ordinary user turn, no Compact dispatch");
    }
  } finally {
    child.kill();
    terminal.close();
    await child.exited;
  }
}

try {
  const action = MANAGER_BUILTIN_ACTIONS.find(def => def.id === "manager-compact");
  if (action?.kind !== "claude") throw new Error("manager compact action missing");
  const messages = compactMessages("codex", applyVars(action.prompt, { today: "Monday, September 14, 2026" }));
  await probe("bare", messages.at(-1)!, true);
  await probe("inline", "/compact focus", false);
  console.log("Recognition only; provider intentionally unreachable. No live sessions used.");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
