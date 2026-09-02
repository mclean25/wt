import { homedir } from "node:os";
import { Effect } from "effect";

import { createLogger } from "../logger.ts";
import { run } from "../proc.ts";
import { TMUX_SOCKET } from "./naming.ts";

const log = createLogger("[tmux]");

export function killByName(name: string): Effect.Effect<void> {
  return run(["tmux", "-L", TMUX_SOCKET, "kill-session", "-t", `=${name}`]).pipe(
    Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1, timedOut: false })),
    Effect.tap((r) => Effect.sync(() => {
  // tmux exits non-zero for "session not found" (the desired no-op
  // path when killing an absent slot) but ALSO for connection /
  // permission failures. Filter the benign case so the noise floor
  // is low, but surface real errors so a failed kill doesn't look
  // like silent success.
      if (r.exitCode !== 0 && !/can't find session/i.test(r.stderr)) {
        log.warn("tmux kill-session failed", {
          name,
          code: r.exitCode,
          stderr: r.stderr.trim() || null,
        });
      }
    })),
    Effect.asVoid,
  );
}

export const killByNamePromise = (name: string): Promise<void> => Effect.runPromise(killByName(name));

/**
 * Every session name on our private tmux server, including the
 * `<slug>-diff` ones. Used by the reaper and by `attachOrCreate`'s
 * post-detach existence check, which need exact-name matching
 * regardless of kind.
 */
export const listAllSessionsRaw = (): Effect.Effect<Set<string>> =>
  probeSessionNames().pipe(Effect.map((names) => names ?? new Set()));

export const listAllSessionsRawPromise = (): Promise<Set<string>> => Effect.runPromise(listAllSessionsRaw());

/**
 * The three-valued form of `listAllSessionsRaw`: `null` means the query
 * FAILED, as distinct from an empty set meaning no sessions exist.
 *
 * Most callers can't act on the difference — they paint glyphs, and a
 * blank badge for one poll is survivable. A caller that would DESTROY
 * something on the strength of "no session by that name" cannot: for it,
 * an unanswerable question must never read as a definite no. That is
 * `prepareInspectorSocket`, which unlinks a session's message socket.
 */
export function probeSessionNames(): Effect.Effect<Set<string> | null> {
  return run([
    "tmux",
    "-L",
    TMUX_SOCKET,
    "list-sessions",
    "-F",
    "#{session_name}",
  ]).pipe(
    Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1, timedOut: false })),
    Effect.map((r) => {
    if (r.exitCode !== 0) {
    // "No server running" is the honest empty — nobody has entered a
    // session yet. Any OTHER failure (spawn refused under fork
    // pressure, a socket we can't reach) is unknown, not empty; the
    // legacy `listAllSessionsRaw` still collapses the two because its
    // ~8 callers only paint UI off it, and turning that into an
    // unhandled rejection fleet-wide would be worse.
    if (!/no server running|error connecting/i.test(r.stderr)) {
      log.warn("tmux list-sessions failed; reporting no sessions", {
        code: r.exitCode,
        stderr: r.stderr.trim() || null,
      });
        return null;
      }
      return new Set<string>();
    }
    const names = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return new Set(names);
    }),
  );
}

export const probeSessionNamesPromise = (): Promise<Set<string> | null> => Effect.runPromise(probeSessionNames());

/**
 * Exact-match target for the *pane* commands below (capture-pane,
 * paste-buffer, send-keys). Their `-t` is a target-pane, where the bare
 * `=name` exact-session prefix that works for `kill-session` is rejected
 * with "can't find pane". The form that both targets the session's active
 * pane AND keeps exact (non-prefix) matching is `=<name>:` — the trailing
 * colon selects the session's current window. Don't drop the colon.
 */
export function paneTarget(name: string): string {
  return `=${name}:`;
}

/**
 * Run a tmux command on our private server; collect exit code + stderr.
 * `cwd` is pinned to `homedir()` rather than `run()`'s default
 * (`config.paths.mainClone`): the first client to touch a socket forks its
 * tmux server, and that server inherits the client's cwd for its whole
 * life (see `tmuxClientCwd` in `core/tmux/attach.ts`). A worktree-
 * rooted cwd is dangerous there — if it's later deleted, the server is
 * left sitting in a nonexistent directory — so every client spawned
 * against this socket, including this one, uses the immortal home
 * directory instead.
 */
export function runTmux(
  args: readonly string[],
): Effect.Effect<{ code: number; stderr: string }> {
  return run(["tmux", "-L", TMUX_SOCKET, ...args], { cwd: homedir() }).pipe(
    Effect.map((r) => ({ code: r.exitCode, stderr: r.stderr })),
    Effect.orElseSucceed(() => ({ code: 1, stderr: "tmux command failed" })),
  );
}

export const runTmuxPromise = (args: readonly string[]): Promise<{ code: number; stderr: string }> =>
  Effect.runPromise(runTmux(args));

/** Snapshot a session's active pane as plain text, or null on failure. */
export function capturePane(name: string): Effect.Effect<string | null> {
  return run([
    "tmux",
    "-L",
    TMUX_SOCKET,
    "capture-pane",
    "-p",
    "-t",
    paneTarget(name),
  ]).pipe(
    Effect.map((r) => r.exitCode === 0 ? r.stdout : null),
    Effect.orElseSucceed(() => null),
  );
}

export const capturePanePromise = (name: string): Promise<string | null> => Effect.runPromise(capturePane(name));
