import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { config } from "../../config.ts";
import { withFileLockAt } from "../../locks.ts";

export const CLAUDE_RUNTIME_REGISTRY_VERSION = 1;

export type ClaudeRuntimeRegistration = {
  version: typeof CLAUDE_RUNTIME_REGISTRY_VERSION;
  sessionId: string;
  cwd: string;
  socketPath: string;
  /** Capability exported by Claude Code to its hooks and Bash children. */
  messagingToken: string | null;
  registeredAt: number;
  updatedAt: number;
};

type RegistryFile = {
  version: typeof CLAUDE_RUNTIME_REGISTRY_VERSION;
  sessions: ClaudeRuntimeRegistration[];
};

export function claudeRuntimeRegistryPath(): string {
  return join(config.paths.cacheRoot, "claude-runtime", "registry.json");
}

function emptyRegistry(): RegistryFile {
  return { version: CLAUDE_RUNTIME_REGISTRY_VERSION, sessions: [] };
}

function parseRegistration(value: unknown): ClaudeRuntimeRegistration | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (
    entry.version !== CLAUDE_RUNTIME_REGISTRY_VERSION ||
    typeof entry.sessionId !== "string" ||
    typeof entry.cwd !== "string" ||
    typeof entry.socketPath !== "string" ||
    (entry.messagingToken !== null && typeof entry.messagingToken !== "string") ||
    typeof entry.registeredAt !== "number" ||
    typeof entry.updatedAt !== "number"
  ) {
    return null;
  }
  return entry as ClaudeRuntimeRegistration;
}

function readFile(path: string): RegistryFile {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (parsed.version !== CLAUDE_RUNTIME_REGISTRY_VERSION) return emptyRegistry();
    const sessions = Array.isArray(parsed.sessions)
      ? parsed.sessions
          .map(parseRegistration)
          .filter((v): v is ClaudeRuntimeRegistration => v !== null)
      : [];
    return { version: CLAUDE_RUNTIME_REGISTRY_VERSION, sessions };
  } catch {
    return emptyRegistry();
  }
}

function writeFile(path: string, registry: RegistryFile): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // rename consumed it, or the write never created it
    }
  }
}

export function readClaudeRuntimeRegistry(
  path = claudeRuntimeRegistryPath(),
): ClaudeRuntimeRegistration[] {
  return readFile(path).sessions;
}

export function registerClaudeRuntime(
  registration: Omit<ClaudeRuntimeRegistration, "version" | "registeredAt" | "updatedAt">,
  opts: { path?: string; now?: number } = {},
): void {
  const path = opts.path ?? claudeRuntimeRegistryPath();
  const now = opts.now ?? Date.now();
  withFileLockAt(`${path}.lock`, () => {
    const registry = readFile(path);
    const previous = registry.sessions.find(
      (entry) =>
        entry.sessionId === registration.sessionId &&
        entry.socketPath === registration.socketPath,
    );
    const next: ClaudeRuntimeRegistration = {
      version: CLAUDE_RUNTIME_REGISTRY_VERSION,
      ...registration,
      registeredAt: previous?.registeredAt ?? now,
      updatedAt: now,
    };
    registry.sessions = [
      ...registry.sessions.filter(
        (entry) =>
          !(
            entry.sessionId === registration.sessionId &&
            entry.socketPath === registration.socketPath
          ),
      ),
      next,
    ];
    writeFile(path, registry);
  });
}

export function unregisterClaudeRuntime(
  match: { sessionId: string; socketPath?: string },
  opts: { path?: string } = {},
): void {
  const path = opts.path ?? claudeRuntimeRegistryPath();
  withFileLockAt(`${path}.lock`, () => {
    const registry = readFile(path);
    const sessions = registry.sessions.filter((entry) => {
      if (entry.sessionId !== match.sessionId) return true;
      return match.socketPath !== undefined && entry.socketPath !== match.socketPath;
    });
    if (sessions.length === registry.sessions.length) return;
    writeFile(path, { ...registry, sessions });
  });
}

/**
 * Remove registrations proven stale from the snapshot a caller validated.
 * Matching updatedAt prevents a liveness sweep from deleting a hook refresh
 * that raced with it after the snapshot was read.
 */
export function pruneClaudeRuntimeRegistrations(
  stale: ReadonlyArray<
    Pick<ClaudeRuntimeRegistration, "sessionId" | "socketPath" | "updatedAt">
  >,
  opts: { path?: string } = {},
): void {
  if (stale.length === 0) return;
  const path = opts.path ?? claudeRuntimeRegistryPath();
  const staleKeys = new Set(
    stale.map((entry) => `${entry.sessionId}\0${entry.socketPath}\0${entry.updatedAt}`),
  );
  withFileLockAt(`${path}.lock`, () => {
    const registry = readFile(path);
    const sessions = registry.sessions.filter((entry) =>
      !staleKeys.has(`${entry.sessionId}\0${entry.socketPath}\0${entry.updatedAt}`)
    );
    if (sessions.length !== registry.sessions.length) {
      writeFile(path, { ...registry, sessions });
    }
  });
}
