import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { config } from "../config.ts";
import { withFileLock } from "../locks.ts";
import { createLogger } from "../logger.ts";
import { parseWorkStatus } from "../work-status.ts";
import { migrateRawWtState, rawWtStateVersion, WT_STATE_VERSION } from "./migrations.ts";
import { GROUP_INBOX, STACK_SECTION_PREFIX } from "./types.ts";
import type { RemovedWorktree, WtSlugState, WtState } from "./types.ts";

/**
 * Directory holding the cross-process state files (`state.json` here,
 * `archive.json` in archive.ts). Exported so the TUI's state-file
 * watcher (`watchWtStateFiles` in repo-watch.ts) observes the same
 * location these writers target. Anchored to the config's cache root
 * (`dirname(cache_db)`) so a second wt instance with its own config
 * gets its own state universe.
 */
export const WT_STATE_DIR = config.paths.cacheRoot;
export const STATE_FILE = join(WT_STATE_DIR, "state.json");
export const log = createLogger("[wtstate]");

export function readWtState(): WtState {
  if (!existsSync(STATE_FILE)) return emptyWtState();
  try {
    const raw = readFileSync(STATE_FILE, "utf8");
    return parseWtState(maybeMigrateRaw(JSON.parse(raw)));
  } catch (err) {
    log.error(err instanceof Error ? err : String(err), { file: STATE_FILE });
    return emptyWtState();
  }
}

/**
 * The hot-path gate for every read: a single integer comparison once
 * the file is at the current version (the common case after the first
 * migrated write). Only version < WT_STATE_VERSION or > WT_STATE_VERSION
 * take a slower path; both are rare (one bump, or a rolled-back binary).
 */
function maybeMigrateRaw(parsed: unknown): Record<string, unknown> {
  const raw = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const from = rawWtStateVersion(raw);
  if (from === WT_STATE_VERSION) return raw;
  if (from > WT_STATE_VERSION) {
    // Newer-code state (rollback scenario): read leniently, never
    // rewrite or stamp — this build doesn't know the newer shape, and
    // `parseWtState` already drops fields it doesn't recognize.
    log.warn("state.json version is newer than this build supports; reading leniently", {
      file: STATE_FILE,
      fileVersion: from,
      buildVersion: WT_STATE_VERSION,
    });
    return raw;
  }
  // from < WT_STATE_VERSION: migrate and persist so this cost is paid
  // once. `readWtState` can itself be called from inside a mutator's
  // `withWtStateLock` critical section (every mutator in sections.ts /
  // removed.ts / automations-pause.ts does `readWtState()` while
  // holding the lock) — flock is per-open-file-description, not
  // reentrant within a process, so re-acquiring here would deadlock.
  // `wtStateLockDepth` tracks whether we're already inside one.
  const persist = (): Record<string, unknown> => migrateAndPersist(raw);
  return wtStateLockDepth > 0 ? persist() : withWtStateLock(persist);
}

/**
 * Runs INSIDE the wtstate lock (held by the caller either way — see
 * `maybeMigrateRaw`). Re-reads the file fresh: another process may have
 * already migrated it while this one waited for the lock, in which case
 * this is a cheap no-op. Backs the pre-migration bytes up, runs the
 * migration chain, and persists the result with the same atomic-rename
 * discipline every writer uses, so a code rollback can restore the
 * backup and keep running against the shape it understands.
 */
function migrateAndPersist(fallback: Record<string, unknown>): Record<string, unknown> {
  let text: string | null = null;
  let current = fallback;
  if (existsSync(STATE_FILE)) {
    try {
      text = readFileSync(STATE_FILE, "utf8");
      current = JSON.parse(text) as Record<string, unknown>;
    } catch (err) {
      // Falling back to the caller's parsed value also SKIPS the backup
      // (no bytes to copy) — worth a trace, since the on-disk file is
      // about to be replaced by this in-memory state.
      log.error(err instanceof Error ? err : String(err), { file: STATE_FILE, phase: "migrate-reread" });
      text = null;
      current = fallback;
    }
  }
  const from = rawWtStateVersion(current);
  if (from >= WT_STATE_VERSION) return current;
  if (text !== null) backupStateFile(text, from);
  const { value } = migrateRawWtState(current);
  try {
    atomicWriteJson(value);
  } catch (err) {
    // Non-fatal: the migrated value is still used in-memory for this
    // read. A failed persist just means the next read repeats this
    // (cheap, idempotent) migration instead of hitting the fast path.
    log.error(err instanceof Error ? err : String(err), { file: STATE_FILE, phase: "migrate-persist" });
  }
  log.info("migrated state.json", { file: STATE_FILE, from, to: WT_STATE_VERSION });
  return value;
}

function backupPath(from: number): string {
  return `${STATE_FILE}.bak-v${from}`;
}

/**
 * Plain byte-for-byte copy of the pre-migration file (not a
 * re-serialization of the parsed value, so it round-trips through a
 * code rollback exactly as it was), overwriting any prior backup for
 * the same `from` — one backup per version bump is enough.
 */
function backupStateFile(text: string, from: number): void {
  try {
    writeFileSync(backupPath(from), text);
  } catch (err) {
    // Best-effort: a failed backup shouldn't brick the app over a
    // migration that (today) is pure version-stamping. Logged so it's
    // not silent.
    log.error(err instanceof Error ? err : String(err), { file: backupPath(from), phase: "migrate-backup" });
  }
}

/**
 * Pure validation/coercion from parsed JSON to `WtState`, split out of
 * `readWtState` so the field-by-field tolerance rules (unknown shapes
 * degrade to defaults rather than throwing) are unit-testable without
 * touching the real state file — `readWtState` reads the fixed
 * `STATE_FILE` under the cache root with no injection seam. Never throws:
 * callers that already have a parsed JSON value (not raw text) can use
 * this directly instead of round-tripping through `readWtState`.
 */
export function parseWtState(raw: unknown): WtState {
  const data = raw as Partial<WtState>;
  const slugs: Record<string, WtSlugState> = {};
  if (data?.slugs && typeof data.slugs === "object") {
    for (const [k, v] of Object.entries(data.slugs)) {
      if (!v || typeof v !== "object") continue;
      const rec = v as Partial<WtSlugState>;
      const section = typeof rec.section === "string" && rec.section.trim() !== ""
        ? rec.section
        : null;
      const order = typeof rec.order === "number" && Number.isFinite(rec.order) ? rec.order : 0;
      slugs[k] = { section, order };
      if (typeof rec.baseBranch === "string" && rec.baseBranch.trim() !== "") {
        slugs[k]!.baseBranch = rec.baseBranch;
        if (typeof rec.baseSha === "string" && rec.baseSha.trim() !== "") {
          slugs[k]!.baseSha = rec.baseSha;
        }
      }
      if (
        typeof rec.devPort === "number" &&
        Number.isInteger(rec.devPort) &&
        rec.devPort > 0 &&
        rec.devPort <= 65_535
      ) {
        slugs[k]!.devPort = rec.devPort;
      }
      if (
        typeof rec.githubIssue === "number" &&
        Number.isInteger(rec.githubIssue) &&
        rec.githubIssue > 0
      ) {
        slugs[k]!.githubIssue = rec.githubIssue;
      }
      if (rec.automationsPaused === true) {
        slugs[k]!.automationsPaused = true;
      }
      const work = parseWorkStatus(rec.work);
      if (work) slugs[k]!.work = work;
    }
  }
  const rawOrder: string[] = [];
  if (Array.isArray(data?.sectionsOrder)) {
    const seen = new Set<string>();
    for (const s of data.sectionsOrder) {
      if (typeof s !== "string" || s.trim() === "") continue;
      if (seen.has(s)) continue;
      seen.add(s);
      rawOrder.push(s);
    }
  }
  let sectionsOrder: string[];
  if (!rawOrder.includes(GROUP_INBOX)) {
    // Pre-unification file (manual names only): seed the unified order
    // with the legacy bucket layout so the migration changes nothing
    // visually — the inbox, then the manual sections in their stored
    // order. Stack keys (inferred at runtime) enter lazily on a move.
    sectionsOrder = [
      GROUP_INBOX,
      ...rawOrder.filter((s) => !s.startsWith(STACK_SECTION_PREFIX)),
    ];
  } else {
    // Stack liveness can't be checked here (stacks are inferred from
    // the live worktree list, which this module doesn't see); stale
    // stack keys are inert — nothing renders for them — and cheap.
    sectionsOrder = rawOrder;
  }
  // Self-heal: any manual section referenced by a slug but missing from
  // sectionsOrder gets appended in discovery order.
  const known = new Set(sectionsOrder);
  for (const v of Object.values(slugs)) {
    if (v.section !== null && !known.has(v.section)) {
      sectionsOrder.push(v.section);
      known.add(v.section);
    }
  }
  const foldedSections: string[] = [];
  if (Array.isArray(data?.foldedSections)) {
    const seen = new Set<string>();
    for (const s of data.foldedSections) {
      if (typeof s !== "string" || s.trim() === "" || seen.has(s)) continue;
      seen.add(s);
      foldedSections.push(s);
    }
  }
  const pausedStacks: string[] = [];
  if (Array.isArray(data?.pausedStacks)) {
    const seen = new Set<string>();
    for (const s of data.pausedStacks) {
      if (typeof s !== "string" || s.trim() === "" || seen.has(s)) continue;
      seen.add(s);
      pausedStacks.push(s);
    }
  }
  const removed: RemovedWorktree[] = [];
  if (Array.isArray(data?.removed)) {
    for (const v of data.removed) {
      if (!v || typeof v !== "object") continue;
      const rec = v as Partial<RemovedWorktree>;
      if (typeof rec.slug !== "string" || rec.slug.trim() === "") continue;
      if (typeof rec.branch !== "string" || rec.branch.trim() === "") continue;
      removed.push({
        slug: rec.slug,
        branch: rec.branch,
        removedAt: typeof rec.removedAt === "string" ? rec.removedAt : "",
        ...(typeof rec.title === "string" && rec.title.trim() !== "" ? { title: rec.title } : {}),
        ...(typeof rec.prNumber === "number" && Number.isFinite(rec.prNumber) ? { prNumber: rec.prNumber } : {}),
        ...(typeof rec.prUrl === "string" && rec.prUrl.trim() !== "" ? { prUrl: rec.prUrl } : {}),
        ...(typeof rec.prState === "string" && rec.prState.trim() !== "" ? { prState: rec.prState } : {}),
      });
    }
  }
  return {
    version: WT_STATE_VERSION,
    slugs,
    sectionsOrder,
    foldedSections,
    pausedStacks,
    automationsPaused: data?.automationsPaused === true,
    attentionSeenTs:
      typeof data?.attentionSeenTs === "number" &&
      Number.isFinite(data.attentionSeenTs) &&
      data.attentionSeenTs > 0
        ? data.attentionSeenTs
        : 0,
    removed,
  };
}

export function emptyWtState(): WtState {
  return {
    version: WT_STATE_VERSION,
    slugs: {},
    sectionsOrder: [],
    foldedSections: [],
    pausedStacks: [],
    automationsPaused: false,
    attentionSeenTs: 0,
    removed: [],
  };
}

/**
 * Write-then-rename so a concurrent reader (the live TUI polls this
 * file) never observes a half-written file and silently falls back to
 * empty defaults. rename(2) is atomic within a filesystem. This closes
 * the torn-read window; lost updates between two WRITERS are closed
 * separately by `withWtStateLock` spanning each mutator's
 * read-modify-write. Shared by `writeWtState` and the migration
 * write-back in `migrateAndPersist` above, which persists raw JSON
 * (mid-chain shapes aren't necessarily valid `WtState` yet) rather than
 * a typed state.
 */
function atomicWriteJson(value: unknown): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, STATE_FILE);
}

export function writeWtState(state: WtState): void {
  try {
    // Every write path stamps the CURRENT version, matching
    // `parseWtState`'s tolerate-unknown-fields contract: a value read
    // leniently from a newer-code file already had its not-yet-known
    // fields dropped at parse time, so there's no newer shape left to
    // preserve by keeping a higher version number here.
    atomicWriteJson({ ...state, version: WT_STATE_VERSION });
  } catch (err) {
    log.error(err instanceof Error ? err : String(err), { file: STATE_FILE });
    // Re-raise so the action layer can surface the failure to the
    // user (toast + event log). Silently swallowing here would
    // present a successful move while the state file is unchanged.
    throw err;
  }
}

/**
 * Reentrancy depth for the wtstate flock. `flock` locks an open file
 * description, not a process — a second `open()` + `flock()` against
 * the same path from the SAME process still blocks (there's no thread
 * to unblock it), so a naive nested `withWtStateLock` call would
 * deadlock. Every mutator in sections.ts/removed.ts/automations-pause.ts
 * calls `readWtState()` while already holding this lock; the migration
 * path in `readWtState` needs to write too, so it checks this depth to
 * decide whether to acquire the lock itself or just run inline under
 * the caller's held lock.
 */
let wtStateLockDepth = 0;

/**
 * Serialize a state-file read-modify-write across processes. The atomic
 * rename in `writeWtState` stops torn reads, but two concurrent WRITERS
 * (the TUI's startup reap vs a CLI `wt base` mutation) each write back
 * from their own pre-write snapshot, silently dropping whichever update
 * landed in between. Every mutator below wraps its read→mutate→write in
 * this blocking flock; the critical sections are pure sync JSON work, so
 * the kernel wait is sub-millisecond and crash-safe (fd close releases).
 */
export function withWtStateLock<T>(fn: () => T): T {
  return withFileLock("__wtstate__", () => {
    wtStateLockDepth++;
    try {
      return fn();
    } finally {
      wtStateLockDepth--;
    }
  });
}
