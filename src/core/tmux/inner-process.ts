import type { SessionKind } from "./naming.ts";

type InnerSessionKind = Exclude<SessionKind, "action" | "dev">;

/** Whether a session preserves short-lived startup errors after its pane exits. */
export function capturesInnerStderr(kind: InnerSessionKind): boolean {
  return kind !== "shell";
}

/**
 * Strip tmux identity from every inner process, and capture stderr only
 * for harness / diff sessions whose startup errors would otherwise
 * disappear with a short-lived pane. Interactive shells must inherit
 * stderr through the tmux PTY: programs such as Corepack write prompts
 * there and then wait on stdin, so redirecting it makes them look hung.
 *
 * The capture branch uses `exec` to keep the process tree flat, and
 * passes `stderrPath` as `$1` so callers never have to shell-escape it.
 * Shared by attached, detached, and injected session creation paths so
 * their routing policy cannot drift.
 */
export function wrapInnerArgs(
  kind: InnerSessionKind,
  stderrPath: string,
  innerArgs: string[],
): string[] {
  const envPrefix = [
    "env",
    "-u",
    "TMUX",
    "-u",
    "TMUX_PANE",
  ];
  if (!capturesInnerStderr(kind)) return [...envPrefix, ...innerArgs];
  return [
    ...envPrefix,
    "bash",
    "-c",
    'p="$1"; shift; exec "$@" 2> "$p"',
    "_wt_wrap",
    stderrPath,
    ...innerArgs,
  ];
}
