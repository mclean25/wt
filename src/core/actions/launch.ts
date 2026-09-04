import { join } from "node:path";

import type { ToolStartMap } from "../harness/claude/events.ts";
import { config, type ActionDef, type RemoteConfig } from "../config.ts";
import type { HarnessId } from "../harness/index.ts";
import { remoteProcessSshArgv, remoteWtSshArgv } from "../remote.ts";
import type { ActionRunKind } from "./types.ts";
import type { ActionVars } from "./types.ts";
import { applyVars } from "./template.ts";

export function actionsDir(): string {
  return join(config.paths.logDir, "actions");
}

export function headlessPromptRunner(
  harnessId: HarnessId,
  prompt: string,
  cwd: string,
): { kind: ActionRunKind; argv: string[] } {
  switch (harnessId) {
    case "claude":
      return {
        kind: "claude",
        argv: [
          "claude",
          "-p",
          "--permission-mode",
          "auto",
          "--verbose",
          "--output-format",
          "stream-json",
          prompt,
        ],
      };
    case "codex":
      return {
        kind: "harness",
        argv: ["codex", "exec", "--color", "never", "--", prompt],
      };
    case "opencode":
      return {
        kind: "harness",
        argv: ["opencode", "run", "--dir", cwd, "--", prompt],
      };
    default: {
      const _exhaustive: never = harnessId;
      throw new Error(`unhandled harness id: ${String(_exhaustive)}`);
    }
  }
}

export type PreparedRemoteAction = {
  argv: string[];
  kind: ActionRunKind;
  prompt: string;
};

/**
 * The single local/remote execution boundary for tracked actions. Everything
 * before this function is location-neutral; this converts one rendered action
 * into the SSH argv supervised by the ordinary local action registry.
 */
export function prepareRemoteAction(
  def: ActionDef,
  remote: RemoteConfig,
  remoteCwd: string,
  slug: string,
  extras: string,
  vars: ActionVars,
  harnessId: HarnessId,
): PreparedRemoteAction {
  const renderedExtras = applyVars(extras, vars).trim();
  const renderedPrompt = def.kind === "claude" ? applyVars(def.prompt, vars) : "";
  const fullPrompt =
    def.kind === "claude"
      ? renderedExtras
        ? `${renderedPrompt}\n\n${renderedExtras}`
        : renderedPrompt
      : "";
  const shell = def.kind === "shell" ? applyVars(def.shell, vars) : "";
  const payload = def.kind === "shell" ? shell : fullPrompt;
  const kind: ActionRunKind =
    def.kind === "shell"
      ? "shell"
      : headlessPromptRunner(harnessId, fullPrompt, remoteCwd).kind;

  // These builtins contain the controlling installation's absolute wt path
  // for local non-interactive shells. On a remote target, address wt through
  // its configured endpoint instead. User shell actions remain verbatim.
  const wtArgv =
    def.id === "dev-server-start"
      ? ["dev", "start", slug]
      : def.id === "dev-server-stop"
        ? ["dev", "stop", slug]
        : null;
  const processArgv = def.kind === "shell"
    ? ["/bin/sh", "-lc", payload]
    : headlessPromptRunner(harnessId, fullPrompt, remoteCwd).argv;
  return {
    argv: wtArgv
      ? remoteWtSshArgv(remote, wtArgv)
      : remoteProcessSshArgv(remote, remoteCwd, processArgv),
    kind,
    prompt: payload,
  };
}

/** Filesystem-safe per-run directory id: `<slug>-<iso>` with `:`/`.`
 *  replaced. Stable across reads of the same run; distinct across
 *  runs even on the same slug. */
export function formatRunId(slug: string, startedAt: number): string {
  return `${slug}-${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}`;
}

export function makeFreshHandles(): {
  toolStarts: ToolStartMap;
  resultEventSeen: boolean;
} {
  return { toolStarts: new Map(), resultEventSeen: false };
}
