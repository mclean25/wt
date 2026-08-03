/**
 * Package-manager detection for the two install paths:
 *
 *  - `resolveInstallCommand` — the full install run in a fresh
 *    git-worktree checkout (`createWorktree`).
 *  - `resolveMainSyncInstall` — the frozen install `fetchOrigin` runs in
 *    the main clone when trunk changed its lockfile, keeping
 *    `node_modules` in sync so rift's CoW clones copy fresh packages.
 *
 * Both honor `[lifecycle] install_command` (run via `$SHELL -lc` so
 * pipes and PATH additions work); otherwise the manager is detected
 * from the directory's lockfile. The auto-detected sync path uses
 * frozen variants because a main-clone install must never rewrite the
 * committed lockfile — that would dirty the main clone and break the
 * next fast-forward. An `install_command` override is used VERBATIM on
 * both paths (wt can't derive a frozen twin from an arbitrary command),
 * so the override itself must be lockfile-safe; documented in
 * docs/configuration.md.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.ts";

type LockfileEntry = {
  lockfile: string;
  install: readonly string[];
  frozenInstall: readonly string[];
};

// Order matters only for pathological multi-lockfile checkouts: the
// more specific/modern managers win over npm's.
const LOCKFILES: readonly LockfileEntry[] = [
  { lockfile: "bun.lock", install: ["bun", "install"], frozenInstall: ["bun", "install", "--frozen-lockfile"] },
  { lockfile: "bun.lockb", install: ["bun", "install"], frozenInstall: ["bun", "install", "--frozen-lockfile"] },
  { lockfile: "pnpm-lock.yaml", install: ["pnpm", "install"], frozenInstall: ["pnpm", "install", "--frozen-lockfile"] },
  { lockfile: "yarn.lock", install: ["yarn", "install"], frozenInstall: ["yarn", "install", "--frozen-lockfile"] },
  // `npm ci` is npm's only never-rewrites-the-lockfile mode; it's a full
  // reinstall, but the sync path only runs when the lockfile changed.
  { lockfile: "package-lock.json", install: ["npm", "install"], frozenInstall: ["npm", "ci"] },
  { lockfile: "npm-shrinkwrap.json", install: ["npm", "install"], frozenInstall: ["npm", "ci"] },
];

/** Every lockfile name wt knows; the main-sync change gate under an `install_command` override. */
const ALL_LOCKFILES: readonly string[] = LOCKFILES.map((e) => e.lockfile);

export type InstallCommand = {
  argv: string[];
  /** Human-readable command for phase labels, log lines, and errors. */
  label: string;
};

export type MainSyncInstall = InstallCommand & {
  /** Lockfile paths whose trunk-side change gates the sync. */
  gateLockfiles: readonly string[];
};

function detect(dir: string): LockfileEntry | null {
  for (const entry of LOCKFILES) {
    if (existsSync(join(dir, entry.lockfile))) return entry;
  }
  return null;
}

function overrideArgv(command: string): string[] {
  return [process.env.SHELL || "bash", "-lc", command];
}

/**
 * The install to run in a fresh checkout: the `[lifecycle]
 * install_command` override, else the package manager detected from the
 * checkout's lockfile. Null = nothing to run (no override, no lockfile).
 */
export function resolveInstallCommand(dir: string): InstallCommand | null {
  const override = config.lifecycle.installCommand;
  if (override) return { argv: overrideArgv(override), label: override };
  const entry = detect(dir);
  if (!entry) return null;
  return { argv: [...entry.install], label: entry.install.join(" ") };
}

/**
 * The install for the main-clone dependency sync: the detected
 * manager's frozen variant, or the `install_command` override verbatim
 * (must be lockfile-safe — see the module doc). With an override the
 * change gate widens to every known lockfile (wt can't know which one
 * the custom command reads); a repo using none of them never trips the
 * gate, so the sync stays inert there even with an override set. Null =
 * no override and no lockfile.
 */
export function resolveMainSyncInstall(dir: string): MainSyncInstall | null {
  const override = config.lifecycle.installCommand;
  if (override) {
    return { argv: overrideArgv(override), label: override, gateLockfiles: ALL_LOCKFILES };
  }
  const entry = detect(dir);
  if (!entry) return null;
  return {
    argv: [...entry.frozenInstall],
    label: entry.frozenInstall.join(" "),
    gateLockfiles: [entry.lockfile],
  };
}
