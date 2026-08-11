import {
  registerClaudeRuntime,
  unregisterClaudeRuntime,
} from "../../core/harness/claude/runtime-registry.ts";

type HookInput = {
  session_id?: unknown;
  cwd?: unknown;
};

function parseInput(raw: string): HookInput {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

/** Internal Claude hook. It must stay silent: hook stdout becomes session context. */
export async function run(argv: string[]): Promise<number> {
  const [action] = argv;
  if (action !== "register" && action !== "unregister") return 2;

  const input = parseInput(await Bun.stdin.text());
  const sessionId =
    typeof input.session_id === "string"
      ? input.session_id
      : process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return 0;

  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  if (action === "unregister") {
    unregisterClaudeRuntime({ sessionId, socketPath });
    return 0;
  }

  const cwd = typeof input.cwd === "string" ? input.cwd : process.cwd();
  if (!socketPath) return 0;
  registerClaudeRuntime({
    sessionId,
    cwd,
    socketPath,
    messagingToken: process.env.CLAUDE_CODE_MESSAGING_TOKEN ?? null,
  });
  return 0;
}
