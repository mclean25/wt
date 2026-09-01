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

/** Canonical absolute path, resolving symlinks when the target exists. */
function canonicalPath(path: string): string {
  const resolved = resolve(path);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

/** Is `child` at or below `parent`? */
export function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The repository config that OWNS the repository, given whatever config
 * discovery found walking up from the cwd.
 *
 * Discovery answers "which `.wt.toml` is nearest to where I was invoked",
 * and that is not the same question as "which repository am I acting on".
 * The backends clone the whole tree, so every worktree carries a COPY of
 * the repository's `.wt.toml` — and a shell that never entered the repo at
 * all finds nothing. Both are the same repository, so both must resolve to
 * the same file: identity that varies with the caller's cwd partitions the
 * durable state database, the cache root and the tmux socket into parallel
 * universes that cannot see each other, while each one looks internally
 * consistent.
 *
 * A `.wt.toml` OUTSIDE `worktree_root` is a repository root and still names
 * itself, which is what keeps multiple repositories isolated. A main clone
 * with no config of its own keeps whatever was discovered: the content is
 * still wanted, and `build` identifies by `paths.main_clone` regardless.
 */
export function canonicalRepositoryConfig(
  discovered: string | null,
  mainClone: string,
  worktreeRoot: string,
): string | null {
  // An absent path resolves to the CWD, which would make this answer depend on
  // the very thing it exists to be independent of. Missing `[paths]` is a hard
  // config error moments later; until then, discovery stands.
  if (!mainClone) return discovered;
  const own = join(canonicalPath(mainClone), REPOSITORY_CONFIG_FILE);
  const ownExists = existsSync(own);
  if (discovered === null) return ownExists ? own : null;
  if (!worktreeRoot) return discovered;
  if (!isInsidePath(worktreeRoot, dirname(canonicalPath(discovered)))) return discovered;
  return ownExists ? own : discovered;
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
