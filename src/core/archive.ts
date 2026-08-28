import { withFileLock } from "./locks.ts";
import { createLogger } from "./logger.ts";
import { readArchivedKeys, writeArchivedKeys } from "./state-db.ts";
import {
  isRemoteWorktreeLedgerKey,
  remoteWorktreeLedgerKey,
  remoteWorktreeLedgerPrefix,
} from "./worktree-ref.ts";

const log = createLogger("[archive]");

/**
 * Read the archived-slug set from disk. Returns an empty set on any
 * IO/parse error so the TUI degrades to "nothing archived" rather
 * than crashing on a corrupt file.
 */
export function readArchived(): Set<string> {
  try {
    return readArchivedKeys();
  } catch (err) {
    log.error(err instanceof Error ? err : String(err));
    return new Set();
  }
}

function writeArchived(set: Set<string>): void {
  writeArchivedKeys(set);
}

/**
 * Serialize the read-modify-write across processes (TUI + the detached
 * destroy + CLI) — same rationale as `withWtStateLock` in wtstate.ts:
 * the atomic rename stops torn reads, the flock stops lost updates.
 */
function withArchiveLock<T>(fn: () => T): T {
  return withFileLock("__archive__", fn);
}

/** Flip the archived flag for a location-aware ledger key. */
export function toggleArchived(key: string): { archived: boolean } {
  return withArchiveLock(() => {
    const set = readArchived();
    const wasArchived = set.has(key);
    if (wasArchived) set.delete(key);
    else set.add(key);
    writeArchived(set);
    return { archived: !wasArchived };
  });
}

/**
 * Idempotent "archive this slug". No-op if already archived; otherwise
 * adds and writes. Used by the TUI's remove/clean flows to tuck the
 * row into the archived section for the duration of the destroy.
 */
export function archiveSlug(slug: string): void {
  withArchiveLock(() => {
    const set = readArchived();
    if (set.has(slug)) return;
    set.add(slug);
    writeArchived(set);
  });
}

/**
 * Drop a slug from the archived set. Called by `createWorktree` so a
 * fresh worktree with a previously-destroyed slug starts un-archived.
 * No-op if the slug wasn't archived.
 */
export function clearArchived(slug: string): void {
  withArchiveLock(() => {
    const set = readArchived();
    if (!set.delete(slug)) return;
    writeArchived(set);
  });
}

/**
 * Drop archive entries that no longer correspond to a live worktree.
 * Run at TUI startup to sweep ghosts left behind by destroys (which
 * intentionally retain archive state — see `removeWorktree`) or by
 * external operations (`git worktree remove` from the shell). No-op
 * when nothing to drop, so the common case is a single read.
 */
export function reapArchived(liveSlugs: ReadonlySet<string>): void {
  withArchiveLock(() => {
    const set = readArchived();
    let changed = false;
    for (const slug of set) {
      // Remote entries are local fleet preferences whose checkouts are not
      // visible to `git worktree list` on this host. They are reconciled by
      // the remote inventory layer, never by the local startup sweep.
      if (isRemoteWorktreeLedgerKey(slug)) continue;
      if (!liveSlugs.has(slug)) {
        set.delete(slug);
        changed = true;
      }
    }
    if (!changed) return;
    writeArchived(set);
  });
}

/**
 * Reap archive keys for one reachable remote host against its authoritative
 * inventory. This is intentionally separate from the local startup sweep:
 * an offline host must retain its last-known fleet preferences.
 */
export function reapRemoteArchived(
  host: string,
  liveSlugs: ReadonlySet<string>,
): void {
  withArchiveLock(() => {
    const set = readArchived();
    const prefix = remoteWorktreeLedgerPrefix(host);
    const liveKeys = new Set(
      [...liveSlugs].map((slug) => remoteWorktreeLedgerKey(host, slug)),
    );
    let changed = false;
    for (const key of set) {
      if (!key.startsWith(prefix) || liveKeys.has(key)) continue;
      set.delete(key);
      changed = true;
    }
    if (changed) writeArchived(set);
  });
}
