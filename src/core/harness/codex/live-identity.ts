import { homedir } from "node:os";
import { Effect } from "effect";

import { run, type ProcError, type RunOptions, type RunResult } from "../../proc.ts";
import { TMUX_SOCKET } from "../../tmux/naming.ts";
import type { HarnessSession } from "../types.ts";

type Inspect = (argv: readonly string[], options: RunOptions) => Effect.Effect<RunResult, ProcError>;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const writerLock = new RegExp(`^n.*\\/thread-writer-locks\\/(${UUID})\\.lock$`, "i");

/** Candidates must already be filtered to this destination's root sessions. */
export function codexWriterIdentity(output: string, sessions: readonly HarnessSession[]): string | null {
  const candidates = new Set(sessions.map((session) => session.sessionId));
  const found = new Set<string>();
  for (const line of output.split("\n")) {
    const id = writerLock.exec(line)?.[1];
    if (id && candidates.has(id)) found.add(id);
  }
  return found.size === 1 ? [...found][0]! : null;
}

function singlePanePid(result: RunResult): string | null {
  if (result.exitCode !== 0 || result.timedOut) return null;
  const lines = result.stdout.trim().split("\n");
  return lines.length === 1 && /^[1-9]\d*$/.test(lines[0]!) ? lines[0]! : null;
}

/** Read-only ownership proof from the live process, never a creation-time guess. */
export const recoverCodexLiveIdentity = Effect.fn("recoverCodexLiveIdentity")(function* (
  tmuxName: string,
  sessions: readonly HarnessSession[],
  inspect: Inspect = run,
) {
  if (sessions.length === 0) return null;
  const paneArgs = ["tmux", "-L", TMUX_SOCKET, "list-panes", "-s", "-t", `=${tmuxName}`, "-F", "#{pane_pid}"];
  const options = { cwd: homedir(), timeoutMs: 2_000 };
  return yield* Effect.gen(function* () {
    const pid = singlePanePid(yield* inspect(paneArgs, options));
    if (!pid) return null;
    const files = yield* inspect(["lsof", "-nP", "-a", "-p", pid, "-Fn"], options);
    if (files.exitCode !== 0 || files.timedOut) return null;
    const id = codexWriterIdentity(files.stdout, sessions);
    if (!id) return null;
    const currentPid = singlePanePid(yield* inspect(paneArgs, options));
    return currentPid === pid ? id : null;
  }).pipe(Effect.orElseSucceed(() => null));
});
