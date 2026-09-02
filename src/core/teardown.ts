/**
 * Project-supplied teardown hooks — the shared machinery behind
 * `[lifecycle] destroy_command` (the worktree is going away) and
 * `[dev_server] stop_command` (the dev server is going down).
 *
 * Both exist for the same blind spot: wt supervises a PROCESS, and a
 * dev command routinely creates resources that are not its children and
 * hold no cwd inside the worktree — docker containers (their host ports
 * belong to the daemon), tunnels, sandboxes. Nothing about those is
 * reachable through the process tree, so neither the destroy reaper nor
 * killing a tmux session releases them. Only the project knows what it
 * created, so the knowledge lives in the project's config, not here.
 *
 * The two hooks are deliberately separate keys rather than one: a
 * destroy teardown may legitimately be heavier than a stop teardown
 * (dropping volumes, removing generated trees), and running the destroy
 * one on an ordinary `wt dev stop` would be a nasty surprise.
 *
 * Config-free by construction (proc + logger only) so both callers can
 * use it without dragging a config import into their module graph.
 */
import { createLogger } from "./logger.ts";
import { Effect } from "effect";
import { runStreamingEffect } from "./proc.ts";

const log = createLogger("[teardown]");

/**
 * Bound on a teardown command. Sized for the realistic worst case these
 * exist for — `docker compose down` on a ten-plus container stack, tens
 * of seconds — with headroom. On expiry the child is killed and the
 * caller continues: whatever the teardown was going to release simply
 * leaks, which is exactly the behavior with no hook at all.
 */
export const TEARDOWN_TIMEOUT_MS = 120_000;

export type TeardownVars = { path: string; slug: string; port: number | null };

/**
 * Substitute `{{path}}` / `{{slug}}` / `{{port}}` into a teardown
 * command template. Null = don't run anything.
 *
 * A template naming `{{port}}` with no port ever allocated resolves to
 * null rather than to a command with a hole in it. That reads as a
 * special case but is the honest one: the port is recorded when a dev
 * server first starts, so "no port" means this worktree never ran one,
 * which means the resources such a template tears down were never
 * created. Templates that don't mention the port always run.
 */
export function resolveTeardownCommand(
  template: string | null,
  vars: TeardownVars,
): string | null {
  if (!template) return null;
  if (template.includes("{{port}}") && vars.port === null) return null;
  return template
    .replaceAll("{{path}}", vars.path)
    .replaceAll("{{slug}}", vars.slug)
    .replaceAll("{{port}}", String(vars.port ?? ""));
}

/**
 * Run a resolved teardown command. Never throws and never reports
 * failure to the caller as anything but a log line: a teardown script
 * that exits non-zero, or hangs until the bound kills it, must not
 * strand the operation it was attached to. The failure mode these hooks
 * exist to fix is a leak, and refusing the destroy (or the stop) turns
 * one leak into a bigger one.
 */
export function runTeardownCommandEffect(opts: {
  /** Config key name, used verbatim in log lines: `destroy_command`, … */
  label: string;
  command: string;
  /** Where to run it. Must still exist — callers run this before deleting. */
  cwd: string;
  slug: string;
  onLog?: (line: string) => void;
}): Effect.Effect<boolean> {
  const { label, command, cwd, slug, onLog } = opts;
  onLog?.(`${label}: ${command}`);
  return runStreamingEffect([process.env.SHELL || "bash", "-lc", command], {
    cwd,
    onLine: (line) => onLog?.(line),
    killAfterMs: TEARDOWN_TIMEOUT_MS,
  }).pipe(
    Effect.map((exit) => {
      if (exit !== 0) {
        onLog?.(`${label} failed (exit ${exit}) — continuing`);
        log.warn(`${label} failed`, { slug, exit });
        return false;
      }
      return true;
    }),
    Effect.catch((err) => Effect.sync(() => {
      onLog?.(
        `${label} errored: ${err instanceof Error ? err.message : String(err)} — continuing`,
      );
      return false;
    })),
  );
}

export const runTeardownCommand = (opts: Parameters<typeof runTeardownCommandEffect>[0]): Promise<boolean> =>
  Effect.runPromise(runTeardownCommandEffect(opts));
