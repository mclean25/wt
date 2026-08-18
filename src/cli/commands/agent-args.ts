export type AgentArgs =
  | { kind: "help" }
  | { kind: "send"; target: string; textArgs: string[] }
  | { kind: "start"; target: string }
  | { kind: "error"; message: string };

/** Pure argv parser kept separate so the CLI contract is testable without config. */
export function parseAgentArgs(argv: string[]): AgentArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const [sub, target, ...rest] = argv;
  if (sub !== "send" && sub !== "start") {
    return { kind: "error", message: sub ? `unknown agent subcommand: ${sub}` : "missing agent subcommand" };
  }
  if (!target) return { kind: "error", message: `wt agent ${sub} requires a worktree` };
  if (sub === "start") {
    if (rest.length > 0) {
      return { kind: "error", message: "wt agent start takes exactly one worktree" };
    }
    return { kind: "start", target };
  }
  return { kind: "send", target, textArgs: rest };
}

/** Invoke a skill using the selected harness's native command prefix. */
export function skillPrompt(prefix: string, name: string): string {
  return `${prefix}${name}`;
}
