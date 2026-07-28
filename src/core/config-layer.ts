import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const REPOSITORY_CONFIG_FILE = ".wt.toml";
export const REPOSITORY_CONFIG_ENV = "WT_REPO_CONFIG";

export type RawConfig = Record<string, unknown>;

function isTable(value: unknown): value is RawConfig {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Find the nearest repository config, or honor the path inherited by a child process. */
export function repositoryConfigPath(
  cwd = process.cwd(),
  env = process.env,
): string | null {
  const inherited = env[REPOSITORY_CONFIG_ENV];
  if (inherited) return resolve(inherited);

  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, REPOSITORY_CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Recursively merge TOML tables; scalar values and arrays are replaced whole. */
export function mergeConfig(base: RawConfig, override: RawConfig): RawConfig {
  const merged: RawConfig = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const prior = merged[key];
    merged[key] = isTable(prior) && isTable(value)
      ? mergeConfig(prior, value)
      : value;
  }
  return merged;
}
