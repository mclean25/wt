/** Manual installed-TUI smoke: bun scripts/codex-compact-recognition.ts
 * Uses real tmux input and the production Codex fallback, with isolated homes,
 * cache and socket. Proves native command completion using a local fake Responses provider.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

for (const executable of ["codex", "tmux"]) {
  if (!Bun.which(executable)) throw new Error(`${executable} must be installed on PATH`);
}
const scratch = mkdtempSync(join(tmpdir(), "wt-compact-recognition-"));
const socket = `wt-compact-smoke-${process.pid}`;
const home = join(scratch, "home");
mkdirSync(home);
const configPath = join(scratch, "wt.toml");
writeFileSync(configPath, `[paths]\nmain_clone = ${JSON.stringify(scratch)}\nworktree_root = ${JSON.stringify(scratch)}\ncache_db = ${JSON.stringify(join(scratch, "cache.sqlite"))}\n[branch]\nprefix = "smoke"\n`);
// Set isolation before importing any production modules with eager config.
process.env.CODEX_HOME = home;
process.env.WT_CONFIG = configPath;
process.env.WT_REPO_CONFIG = configPath;
process.env.WT_TMUX_SOCKET = socket;
process.chdir(scratch);
let session = "manager-codex";
const env = { PATH: process.env.PATH!, HOME: home, CODEX_HOME: home, TERM: "xterm-256color" };
async function tmux(...args: string[]) {
  const child = Bun.spawn(["tmux", "-L", socket, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`tmux ${args[0]}: ${stderr}`);
  return stdout;
}
const screen = () => tmux("capture-pane", "-p", "-t", session);
async function waitFor(predicate: () => Promise<boolean> | boolean, label: string) {
  const deadline = Date.now() + 25000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}:\n${await screen()}`);
    await Bun.sleep(50); // Polling real OS/TUI state.
  }
}
function dispatchCount() {
  try {
    const db = new Database(join(home, "logs_2.sqlite"), { readonly: true });
    try {
      return Number((db.query("select count(*) as count from logs where target='codex_core::session::handlers' and feedback_log_body like '%op: Compact%'").get() as { count: number }).count);
    } finally { db.close(); }
  } catch { return 0; }
}
let requests = 0;
const provider = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
  await request.text();
  requests++;
  const message = { id: `msg_${requests}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Harmless smoke test context summary." }] };
  const events = [
    { type: "response.created", response: { id: `resp_${requests}`, status: "in_progress", output: [] } },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: { id: `resp_${requests}`, status: "completed", output: [message], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
} });
function rollout() {
  try {
    return readdirSync(join(home, "sessions"), { recursive: true }).filter(path => String(path).endsWith(".jsonl")).flatMap(path => readFileSync(join(home, "sessions", String(path)), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  } catch { return []; }
}
try {
  const { injectCodexFallback } = await import("../src/core/tmux/inject.ts");
  const { sessionName } = await import("../src/core/tmux/naming.ts");
  const { compactCommand } = await import("../src/core/harness/compact.ts");
  const { CODEX_MANAGER_PROMPT } = await import("../src/core/harness/codex/slot.ts");
  session = sessionName("manager", "codex", null);
  await tmux("-f", "/dev/null", "new-session", "-d", "-s", session, "-x", "120", "-y", "40", "codex", "-C", scratch, "--no-alt-screen",
    "-c", 'model_provider="probe"', "-c", 'model="probe"',
    "-c", 'model_providers.probe.name="probe"',
    "-c", `model_providers.probe.base_url="http://127.0.0.1:${provider.port}/v1"`,
    "-c", 'model_providers.probe.wire_api="responses"',
    "-c", "model_providers.probe.request_max_retries=0", "-c", "model_providers.probe.stream_max_retries=0", CODEX_MANAGER_PROMPT);
  await waitFor(async () => /Trust and continue|probe default/.test(await screen()), "trust/composer");
  if ((await screen()).includes("Trust and continue")) await tmux("send-keys", "-t", session, "Enter");
  await waitFor(async () => (await screen()).includes("probe default"), "initialized composer");
  await waitFor(() => rollout().some(event => event.payload?.type === "task_complete"), "seed turn completion");
  const { probeCodexCommandReadiness, waitForCodexLivePaneReady } = await import("../src/core/harness/codex/readiness.ts");
  const sessionId = rollout().find(event => event.type === "session_meta")?.payload?.id;
  if (!sessionId) throw new Error("Missing test session UUID");
  await tmux("set-option", "-t", session, "@wt-harness-session-id", sessionId);
  const ready = probeCodexCommandReadiness({ slug: "manager", cwd: scratch, sessionId, sessionsDir: join(home, "sessions") });
  const userTurns = () => rollout().filter(event => event.type === "response_item" && event.payload?.type === "message" && event.payload?.role === "user");
  const usersBefore = JSON.stringify(userTurns());
  const command = compactCommand("codex", "/compact This is context today is Tuesday, September 29, 2026.");
  if (command !== "/compact") throw new Error(`Expected native bare command, got ${command}`);
  const result = await Effect.runPromise(injectCodexFallback({ slug: "manager", cwd: scratch, text: command }, waitForCodexLivePaneReady({ slug: "manager", timeoutMs: 10000 }), ready));
  if (!result.ok) throw new Error(result.reason);
  if (result.delivered !== null || result.resent) throw new Error("Native compaction must not poll a user-message receipt or retry submission");
  await waitFor(() => dispatchCount() === 1, "exactly one native Compact dispatch");
  await waitFor(() => rollout().some(event => event.type === "compacted"), "persisted compacted event");
  if (JSON.stringify(userTurns()) !== usersBefore) throw new Error("Compaction added an unexpected user turn");
  console.log("PASS: production injectCodexFallback typed into isolated manager tmux; installed Codex dispatched exactly one native Compact.");
  console.log("PASS: local fake provider completed native compaction and persisted compacted event; no additional user turn or preparation turn. No live sessions or credentials used.");
} finally {
  await tmux("kill-server").catch(() => {});
  provider.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
