/**
 * Self-update for the wt source clone. The install IS a git clone
 * (README), so "update" means fast-forwarding it: `git fetch` +
 * `git merge --ff-only @{u}`, plus a `bun install` when the lockfile
 * moved. Consumed by `wt update` / `wt version` (cli/commands/) and the
 * pre-TUI startup prompt in main.ts.
 *
 * The check memory (`~/.cache/wt/update.json`) is deliberately pinned
 * to `~/.cache/wt` rather than the config's cache root, same as the
 * skills memory: there is one source clone per machine, so the daily
 * rate limit and remembered declines must be shared by every instance
 * running from it — including a sealed second instance with its own
 * cache_db.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { withFileLockAt } from "./locks.ts";
import { createLogger } from "./logger.ts";
import { run } from "./proc.ts";

const log = createLogger("[update]");

/** Repo root of the wt source tree (this file is `<root>/src/core/update.ts`). */
export const WT_REPO_ROOT: string = resolve(import.meta.dir, "..", "..");

/** Run git in the source clone; trimmed stdout, or null on any failure. */
async function gitOk(args: string[], timeoutMs = 10_000): Promise<string | null> {
  const r = await run(["git", ...args], { cwd: WT_REPO_ROOT, timeoutMs });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

// ── Version ────────────────────────────────────────────────────────────

let _version: string | null = null;

/**
 * The running version: `<short-sha> (<commit-date>)`, with a `-dirty`
 * suffix on the sha when the clone has local modifications. Sync and
 * cached for the process lifetime — callers are the help overlay title
 * and `wt version`, both fine paying one ~5ms git call once. The cache
 * is invalidated by `applyWtUpdate` so a post-pull read shows the new
 * HEAD.
 */
export function wtVersion(): string {
  if (_version !== null) return _version;
  const head = gitSync(["log", "-1", "--format=%h %cs"]);
  if (!head) return (_version = "unknown");
  const [sha, date] = head.split(" ");
  const dirty = gitSync(["status", "--porcelain"]);
  _version = `${sha}${dirty ? "-dirty" : ""}${date ? ` (${date})` : ""}`;
  return _version;
}

function gitSync(args: string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", WT_REPO_ROOT, ...args], {
      stdout: "pipe",
      stderr: "ignore",
    });
    return r.exitCode === 0 ? r.stdout.toString().trim() : null;
  } catch {
    return null;
  }
}

// ── Check memory ───────────────────────────────────────────────────────

export const UPDATE_MEMORY_FILE = join(homedir(), ".cache", "wt", "update.json");

export type UpdateMemory = {
  /** Epoch ms of the last startup check that reached the fetch step. */
  lastCheckAt: number | null;
  /** Remote head (short sha) the user declined; never re-offered until origin moves. */
  declinedSha: string | null;
};

export function emptyUpdateMemory(): UpdateMemory {
  return { lastCheckAt: null, declinedSha: null };
}

export function parseUpdateMemory(raw: unknown): UpdateMemory {
  const data = raw as Partial<UpdateMemory> | null;
  const out = emptyUpdateMemory();
  if (typeof data?.lastCheckAt === "number" && Number.isFinite(data.lastCheckAt)) {
    out.lastCheckAt = data.lastCheckAt;
  }
  if (typeof data?.declinedSha === "string" && data.declinedSha) {
    out.declinedSha = data.declinedSha;
  }
  return out;
}

export function readUpdateMemory(): UpdateMemory {
  if (!existsSync(UPDATE_MEMORY_FILE)) return emptyUpdateMemory();
  try {
    return parseUpdateMemory(JSON.parse(readFileSync(UPDATE_MEMORY_FILE, "utf8")));
  } catch (err) {
    log.error(err instanceof Error ? err : String(err), { file: UPDATE_MEMORY_FILE });
    return emptyUpdateMemory();
  }
}

function mutateUpdateMemory(fn: (mem: UpdateMemory) => void): void {
  withFileLockAt(`${UPDATE_MEMORY_FILE}.lock`, () => {
    const mem = readUpdateMemory();
    fn(mem);
    mkdirSync(dirname(UPDATE_MEMORY_FILE), { recursive: true });
    const tmp = `${UPDATE_MEMORY_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(mem, null, 2)}\n`);
    renameSync(tmp, UPDATE_MEMORY_FILE);
  });
}

/** Stamp the daily check (written BEFORE fetching — one attempt/day even offline). */
export function rememberUpdateCheck(now: number): void {
  mutateUpdateMemory((m) => {
    m.lastCheckAt = now;
  });
}

export function rememberUpdateDecline(remoteSha: string): void {
  mutateUpdateMemory((m) => {
    m.declinedSha = remoteSha;
  });
}

/** A successful update clears any stale decline. */
export function rememberUpdateApplied(now: number): void {
  mutateUpdateMemory((m) => {
    m.lastCheckAt = now;
    m.declinedSha = null;
  });
}

// ── Repo state ─────────────────────────────────────────────────────────

export type RepoUpdateState = {
  /** Uncommitted changes in the source clone. */
  dirty: boolean;
  /** Upstream ref name, or null when HEAD has none (detached, local branch). */
  upstream: string | null;
  /** Local commits not on upstream. */
  ahead: number;
  /** Upstream commits not local (as of the last fetch). */
  behind: number;
  headSha: string;
  remoteSha: string;
};

/** Null when the source tree isn't a git checkout (or git is missing). */
export async function repoUpdateState(): Promise<RepoUpdateState | null> {
  const headSha = await gitOk(["rev-parse", "--short", "HEAD"]);
  if (headSha === null) return null;
  const status = await gitOk(["status", "--porcelain"]);
  const dirty = status !== null && status.length > 0;
  const upstream = await gitOk(["rev-parse", "--abbrev-ref", "@{u}"]);
  if (upstream === null) {
    return { dirty, upstream: null, ahead: 0, behind: 0, headSha, remoteSha: "" };
  }
  const counts = (await gitOk(["rev-list", "--left-right", "--count", "@{u}...HEAD"])) ?? "0 0";
  const [behindRaw, aheadRaw] = counts.split(/\s+/);
  const remoteSha = (await gitOk(["rev-parse", "--short", "@{u}"])) ?? "";
  return {
    dirty,
    upstream,
    ahead: parseInt(aheadRaw ?? "0", 10) || 0,
    behind: parseInt(behindRaw ?? "0", 10) || 0,
    headSha,
    remoteSha,
  };
}

// ── Decisions (pure — tested in update.test.ts) ────────────────────────

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type StartupGate = "run" | "local-changes" | "rate-limited";

/**
 * Should the startup check fetch at all? Local divergence (dirty /
 * ahead / no upstream) means the human is driving this clone by hand —
 * skip silently, per the design: wt never touches a clone it might
 * fight with. The rate limit bounds the check (and its network fetch)
 * to once a day; a future `lastCheckAt` (clock rollback) falls through
 * to "run" so a bad stamp can't wedge the check forever.
 */
export function startupCheckGate(
  state: Pick<RepoUpdateState, "dirty" | "ahead" | "upstream">,
  memory: UpdateMemory,
  now: number,
): StartupGate {
  if (state.dirty || state.ahead > 0 || state.upstream === null) return "local-changes";
  if (
    memory.lastCheckAt !== null &&
    now >= memory.lastCheckAt &&
    now - memory.lastCheckAt < UPDATE_CHECK_INTERVAL_MS
  ) {
    return "rate-limited";
  }
  return "run";
}

export type PostFetchAction = "up-to-date" | "declined" | "offer";

/** After a fetch refreshed the counts: offer, unless there's nothing or it was declined. */
export function postFetchAction(
  state: Pick<RepoUpdateState, "behind" | "remoteSha">,
  memory: UpdateMemory,
): PostFetchAction {
  if (state.behind === 0) return "up-to-date";
  if (memory.declinedSha !== null && memory.declinedSha === state.remoteSha) return "declined";
  return "offer";
}

// ── Actions ────────────────────────────────────────────────────────────

/** One bounded fetch of the clone's default remote. False on failure (offline, auth). */
export async function fetchWtOrigin(): Promise<boolean> {
  const r = await run(["git", "fetch", "--quiet"], { cwd: WT_REPO_ROOT, timeoutMs: 20_000 });
  if (r.exitCode !== 0) log.warn(`git fetch failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  return r.exitCode === 0;
}

/** `%h %s` lines for HEAD..@{u} (what an update would bring in), newest first. */
export async function pendingCommitLines(): Promise<string[]> {
  const out = await gitOk(["log", "--format=%h %s", "HEAD..@{u}"]);
  return out ? out.split("\n").filter(Boolean) : [];
}

export type ApplyResult =
  | { ok: false; detail: string }
  | { ok: true; installedDeps: boolean; depsWarning: string | null };

/**
 * Fast-forward to @{u} (objects already local from the fetch — no
 * second network trip), then `bun install` iff the dependency manifest
 * changed across the jump. An install failure is a warning, not a
 * rollback: the code moved, the caller must surface it.
 */
export async function applyWtUpdate(): Promise<ApplyResult> {
  const before = await gitOk(["rev-parse", "HEAD"]);
  const merge = await run(["git", "merge", "--ff-only", "--quiet", "@{u}"], {
    cwd: WT_REPO_ROOT,
    timeoutMs: 60_000,
  });
  _version = null;
  if (merge.exitCode !== 0) {
    return {
      ok: false,
      detail: merge.stderr.trim() || merge.stdout.trim() || `exit ${merge.exitCode}`,
    };
  }
  let installedDeps = false;
  let depsWarning: string | null = null;
  if (before) {
    const changed = await gitOk([
      "diff",
      "--name-only",
      `${before}..HEAD`,
      "--",
      "package.json",
      "bun.lock",
      "bun.lockb",
    ]);
    if (changed) {
      const inst = await run(["bun", "install"], { cwd: WT_REPO_ROOT, timeoutMs: 180_000 });
      installedDeps = inst.exitCode === 0;
      if (inst.exitCode !== 0) {
        depsWarning = `dependencies changed but \`bun install\` failed (${
          inst.stderr.trim().split("\n").at(-1) ?? `exit ${inst.exitCode}`
        }) — run it in ${WT_REPO_ROOT} manually`;
      }
    }
  }
  return { ok: true, installedDeps, depsWarning };
}

/**
 * PIDs of other live interactive wt instances (bare `main.ts`, no
 * subcommand argv) — they keep running the pre-update code until
 * restarted, so `wt update` names them. Path-anchored to THIS clone;
 * the bare `bun src/main.ts` dev form is accepted as-is (no path to
 * verify, and a false positive only adds an informational line).
 */
export async function listRunningWtInstances(): Promise<number[]> {
  const r = await run(["ps", "-axo", "pid=,command="], { cwd: WT_REPO_ROOT, timeoutMs: 10_000 });
  if (r.exitCode !== 0) return [];
  const pids: number[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m?.[1] || m[2] === undefined) continue;
    const pid = parseInt(m[1], 10);
    if (pid === process.pid) continue;
    const cmd = m[2].trim();
    const isThisClone = cmd.endsWith("/src/main.ts") && cmd.includes(WT_REPO_ROOT);
    if (isThisClone || /^bun src\/main\.ts$/.test(cmd)) pids.push(pid);
  }
  return pids;
}
