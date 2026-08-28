import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";

export const REPOSITORY_CONFIG_FILE = ".wt.toml";
export const REPOSITORY_CONFIG_ENV = "WT_REPO_CONFIG";

export type RawConfig = Record<string, unknown>;

/** Human-readable namespace for a canonical path. */
export function pathNamespace(path: string, home = homedir()): string {
  const resolved = resolve(path);
  const canonical = existsSync(resolved) ? realpathSync(resolved) : resolved;
  const homeDir = resolve(home);
  const fromHome = relative(homeDir, canonical);
  const identity = fromHome !== "" && !fromHome.startsWith("..") && !isAbsolute(fromHome)
    ? fromHome
    : canonical.slice(parse(canonical).root.length);
  return identity
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "repo";
}

/**
 * Stable, human-readable identity for the repository owning a `.wt.toml`.
 * Paths below home omit the machine-specific home prefix:
 * `~/dev/cz/cozee-dev/.wt.toml` becomes `dev-cz-cozee-dev`.
 */
export function repositoryNamespace(
  configPath: string,
  home = homedir(),
): string {
  const resolvedConfig = resolve(configPath);
  const repoDir = dirname(
    existsSync(resolvedConfig) ? realpathSync(resolvedConfig) : resolvedConfig,
  );
  return pathNamespace(repoDir, home);
}

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
