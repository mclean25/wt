import { HARNESSES } from "../../core/harness/registry.ts";
import type { HarnessId } from "../../core/harness/types.ts";

export type AgentArgs =
  | { kind: "help" }
  | { kind: "send"; target: string; textArgs: string[]; harness: HarnessId | null }
  | { kind: "start"; target: string; harness: HarnessId | null }
  | { kind: "error"; message: string };

/**
 * Pull `--harness <id>` (or `--harness=<id>`) out of argv.
 *
 * Explicit addressing exists because there was no supported way to say
 * "this one" — a caller who could see the right session in `tmux
 * list-sessions` had nothing to reach it with but `send-keys`. Removed
 * from the argv it returns, so the remaining positional text is
 * unaffected wherever the flag appeared.
 */
function takeHarnessFlag(
  argv: string[],
): { rest: string[]; harness: HarnessId | null; error?: string } {
  const rest: string[] = [];
  let harness: HarnessId | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    let value: string | undefined;
    if (a === "--harness") {
      value = argv[++i];
      if (value === undefined) return { rest, harness, error: "--harness needs a value" };
    } else if (a.startsWith("--harness=")) {
      value = a.slice("--harness=".length);
    } else {
      rest.push(a);
      continue;
    }
    const match = HARNESSES.find((h) => h.id === value);
    if (!match) {
      return {
        rest,
        harness,
        error: `unknown harness: ${value} (known: ${HARNESSES.map((h) => h.id).join(", ")})`,
      };
    }
    harness = match.id;
  }
  return { rest, harness };
}

/** Pure argv parser kept separate so the CLI contract is testable without config. */
export function parseAgentArgs(argv: string[]): AgentArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const flag = takeHarnessFlag(argv);
  if (flag.error) return { kind: "error", message: flag.error };
  const [sub, target, ...rest] = flag.rest;
  if (sub !== "send" && sub !== "start") {
    return { kind: "error", message: sub ? `unknown agent subcommand: ${sub}` : "missing agent subcommand" };
  }
  if (!target) return { kind: "error", message: `wt agent ${sub} requires a worktree` };
  if (sub === "start") {
    if (rest.length > 0) {
      return { kind: "error", message: "wt agent start takes exactly one worktree" };
    }
    return { kind: "start", target, harness: flag.harness };
  }
  return { kind: "send", target, textArgs: rest, harness: flag.harness };
}

/** Invoke a skill using the selected harness's native command prefix. */
export function skillPrompt(prefix: string, name: string): string {
  return `${prefix}${name}`;
}
