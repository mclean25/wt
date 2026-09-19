/** Identity of the single per-user launchd agent, independent of daemon liveness. */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Effect } from "effect";

import { operationErrors } from "../errors.ts";
import { run } from "../proc.ts";

const io = operationErrors("events agent");
export const EVENTS_AGENT_PATH = join(homedir(), "Library", "LaunchAgents", "com.wt.events.plist");
export const EVENTS_AGENT_LOCK_DIR = join(homedir(), ".cache", "wt");

function canonical(path: string): string {
  return existsSync(path) ? realpathSync(path) : resolve(path);
}

/** Freeze relative config overrides before a child changes cwd or launchd starts it. */
export function eventsConfigEnvironment(env = process.env, cwd = process.cwd()): Record<string, string> {
  const absolute = (value: string) => canonical(resolve(cwd,
    value.startsWith("~/") ? join(homedir(), value.slice(2)) : value));
  return {
    WT_CONFIG: absolute(env.WT_CONFIG || join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "wt", "config.toml")),
    WT_REPO_CONFIG: env.WT_REPO_CONFIG ? absolute(env.WT_REPO_CONFIG) : "",
  };
}

/** Unknown provenance fails closed; a live PID/build never proves repository ownership. */
export function ownsEventsAgent(agent: unknown, expected: Record<string, string>, eventsDir: string): boolean {
  if (!agent || typeof agent !== "object") return false;
  const plist = agent as Record<string, unknown>;
  const env = plist.EnvironmentVariables;
  if (!env || typeof env !== "object") return false;
  const values = env as Record<string, unknown>;
  const repo = values.WT_REPO_CONFIG ?? "";
  if (typeof repo !== "string" || (repo !== "" && !isAbsolute(repo))) return false;
  if ((repo ? canonical(repo) : "") !== expected.WT_REPO_CONFIG) return false;
  // Older installs omitted WT_CONFIG when using the default. Resolve only
  // absolute paths: launchd's cwd is not the installing shell's cwd.
  const global = values.WT_CONFIG || (typeof values.XDG_CONFIG_HOME === "string"
    ? join(values.XDG_CONFIG_HOME, "wt", "config.toml")
    : typeof values.HOME === "string" ? join(values.HOME, ".config", "wt", "config.toml") : null);
  if (typeof global !== "string" || !isAbsolute(global) || canonical(global) !== expected.WT_CONFIG) return false;
  // In particular, global-only legacy agents must point at OUR state tree.
  return plist.StandardOutPath === join(eventsDir, "daemon.out.log") &&
    plist.StandardErrorPath === join(eventsDir, "daemon.err.log");
}

export const readEventsAgent = Effect.fn("readEventsAgent")(function* (path: string) {
  const result = yield* run(["plutil", "-convert", "json", "-o", "-", path], { cwd: process.cwd(), timeoutMs: 5_000 });
  if (result.exitCode !== 0) {
    return yield* io.sync("read launchd plist", () => {
      throw new Error(`${path}: ${result.stderr.trim() || result.stdout.trim() || `plutil exit ${result.exitCode}`}`);
    });
  }
  return yield* io.sync("parse launchd plist", (): unknown => JSON.parse(result.stdout));
});
