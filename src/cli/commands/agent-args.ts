export type AgentArgs =
  | { kind: "help" }
  | { kind: "send"; target: string; textArgs: string[] }
  | { kind: "start"; target: string }
  | { kind: "list"; json: boolean }
  | { kind: "error"; message: string };

export function parseAgentArgs(argv: string[]): AgentArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  if (argv.some((arg) => arg === "--harness" || arg.startsWith("--harness="))) {
    return {
      kind: "error",
      message: "--harness was removed; wt routes to the target's active harness automatically",
    };
  }
  const [sub, target, ...rest] = argv;
  if (sub === "ls") {
    const args = [target, ...rest].filter((arg): arg is string => arg !== undefined);
    const invalid = args.find((arg) => arg !== "--json");
    if (invalid || args.filter((arg) => arg === "--json").length > 1) {
      return { kind: "error", message: `unknown argument for agent ls: ${invalid ?? "--json"}` };
    }
    return { kind: "list", json: args.includes("--json") };
  }
  if (sub !== "send" && sub !== "start") {
    return { kind: "error", message: sub ? `unknown agent subcommand: ${sub}` : "missing agent subcommand" };
  }
  if (!target) return { kind: "error", message: `wt agent ${sub} requires a target` };
  if (sub === "start") {
    if (rest.length > 0) return { kind: "error", message: "wt agent start takes exactly one worktree" };
    return { kind: "start", target };
  }
  return { kind: "send", target, textArgs: rest };
}

export function skillPrompt(prefix: string, name: string): string {
  return `${prefix}${name}`;
}
