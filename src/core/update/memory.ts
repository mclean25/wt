/**
 * Persistent memory for the self-update system: the daily-check stamp,
 * the per-version decline, the update/rollback journal, and the boot
 * sentinel that marks a version "known good". Machine-global at
 * `~/.cache/wt/update.json` (like the skills memory): there is one
 * source clone per machine, so every instance — including a sealed
 * second one with its own cache_db — must share this record.
 *
 * Writes are read-modify-write with an atomic rename but NO flock:
 * `core/locks.ts` pulls in the config chain (and FFI), which this
 * module must not load (see exec.ts). Contention here is a human
 * launching wt twice in the same second — last-write-wins is fine for
 * stamps and offers, and journal entries are only written from
 * interactive accept/rollback moments that don't overlap in practice.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Scope } from "effect";

import { gitSync, logSafe, WT_REPO_ROOT } from "./exec.ts";

export const UPDATE_MEMORY_FILE = join(homedir(), ".cache", "wt", "update.json");

/** Journal entries and shas in memory are FULL shas; display via shortSha. */
export type UpdateJournalEntry = {
  at: number;
  kind: "update" | "rollback";
  fromSha: string;
  toSha: string;
};

export type UpdateMemory = {
  /** Epoch ms of the last check that reached the fetch step. */
  lastCheckAt: number | null;
  /** Offer target the user declined (or that failed smoke); suppressed until the target changes. */
  declinedSha: string | null;
  /** Last sha that completed a healthy boot (survived startup). */
  lastGoodSha: string | null;
  /**
   * Set when a TUI boot starts, cleared when it proves healthy. A
   * leftover entry on the next launch is crash evidence. `root` scopes
   * it to the clone that wrote it: this file is machine-global, and a
   * dev clone's TUI (same machine, different checkout) must not leave
   * crash evidence that the production install then acts on. A
   * cross-clone overwrite can still LOSE a sentinel — that misses an
   * offer (fail-safe) rather than making a wrong one.
   */
  booting: { sha: string; at: number; root: string | null } | null;
  /**
   * Set just before an update's merge moves HEAD, cleared when the
   * journal entry lands (or the update reverts). A leftover entry means
   * the process died mid-update — the offers treat it like a journal
   * record so an interrupted update still gets a rollback target.
   */
  applying: { fromSha: string; toSha: string; at: number } | null;
  /** Applied updates and rollbacks, newest last. Capped. */
  journal: UpdateJournalEntry[];
};

const JOURNAL_CAP = 50;

export function emptyUpdateMemory(): UpdateMemory {
  return {
    lastCheckAt: null,
    declinedSha: null,
    lastGoodSha: null,
    booting: null,
    applying: null,
    journal: [],
  };
}

function optStr(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

function optNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseUpdateMemory(raw: unknown): UpdateMemory {
  const data = raw as Record<string, unknown> | null;
  const out = emptyUpdateMemory();
  if (!data || typeof data !== "object") return out;
  out.lastCheckAt = optNum(data.lastCheckAt);
  out.declinedSha = optStr(data.declinedSha);
  out.lastGoodSha = optStr(data.lastGoodSha);
  const booting = data.booting as Record<string, unknown> | null | undefined;
  if (booting && typeof booting === "object") {
    const sha = optStr(booting.sha);
    const at = optNum(booting.at);
    if (sha && at !== null) out.booting = { sha, at, root: optStr(booting.root) };
  }
  const applying = data.applying as Record<string, unknown> | null | undefined;
  if (applying && typeof applying === "object") {
    const fromSha = optStr(applying.fromSha);
    const toSha = optStr(applying.toSha);
    const at = optNum(applying.at);
    if (fromSha && toSha && at !== null) out.applying = { fromSha, toSha, at };
  }
  if (Array.isArray(data.journal)) {
    for (const e of data.journal) {
      const rec = e as Record<string, unknown> | null;
      if (!rec || typeof rec !== "object") continue;
      const at = optNum(rec.at);
      const fromSha = optStr(rec.fromSha);
      const toSha = optStr(rec.toSha);
      const kind = rec.kind === "rollback" ? "rollback" : rec.kind === "update" ? "update" : null;
      if (at !== null && fromSha && toSha && kind) {
        out.journal.push({ at, kind, fromSha, toSha });
      }
    }
  }
  return out;
}

export function readUpdateMemory(): UpdateMemory {
  if (!existsSync(UPDATE_MEMORY_FILE)) return emptyUpdateMemory();
  try {
    return parseUpdateMemory(JSON.parse(readFileSync(UPDATE_MEMORY_FILE, "utf8")));
  } catch (err) {
    logSafe("error", `unreadable ${UPDATE_MEMORY_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    return emptyUpdateMemory();
  }
}

function fileMtime(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function mutateUpdateMemory(fn: (mem: UpdateMemory) => void): void {
  // Lock-free optimistic concurrency: sentinel writes happen on every
  // boot of every instance, so two processes CAN race this file. Re-run
  // the mutation against a fresh read when the file changed under us;
  // the remaining stat→rename window is microseconds, versus the whole
  // read-mutate-serialize span it would otherwise be.
  for (let attempt = 0; ; attempt++) {
    const mtimeBefore = fileMtime(UPDATE_MEMORY_FILE);
    const mem = readUpdateMemory();
    fn(mem);
    if (mem.journal.length > JOURNAL_CAP) {
      mem.journal = mem.journal.slice(mem.journal.length - JOURNAL_CAP);
    }
    mkdirSync(dirname(UPDATE_MEMORY_FILE), { recursive: true });
    // A kill between write and rename orphans this tmp file (tiny,
    // pid-named, harmless); accepted rather than adding a sweep.
    const tmp = `${UPDATE_MEMORY_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(mem, null, 2)}\n`);
    if (attempt < 3 && fileMtime(UPDATE_MEMORY_FILE) !== mtimeBefore) {
      try {
        unlinkSync(tmp);
      } catch {
        // Already renamed/gone — nothing to clean.
      }
      continue;
    }
    renameSync(tmp, UPDATE_MEMORY_FILE);
    return;
  }
}

/** Stamp the daily check (written BEFORE fetching — one attempt/day even offline). */
export function rememberUpdateCheck(now: number): void {
  mutateUpdateMemory((m) => {
    m.lastCheckAt = now;
  });
}

export function rememberUpdateDecline(targetSha: string): void {
  mutateUpdateMemory((m) => {
    m.declinedSha = targetSha;
  });
}

/**
 * Durable record that a merge is about to move HEAD. Written BEFORE
 * the merge so a kill anywhere in the (potentially minutes-long)
 * merge→deps→probe window still leaves the offers a rollback target;
 * cleared by the success/failure paths that supersede it.
 */
export function markApplying(fromSha: string, toSha: string, now: number): void {
  mutateUpdateMemory((m) => {
    m.applying = { fromSha, toSha, at: now };
  });
}

export function clearApplying(): void {
  mutateUpdateMemory((m) => {
    m.applying = null;
  });
}

/** A successful update: journal it and clear any stale decline. */
export function recordUpdateApplied(args: { now: number; fromSha: string; toSha: string }): void {
  mutateUpdateMemory((m) => {
    m.lastCheckAt = args.now;
    m.declinedSha = null;
    m.applying = null;
    m.journal.push({ at: args.now, kind: "update", fromSha: args.fromSha, toSha: args.toSha });
  });
}

/**
 * A rollback: journal it and decline the sha we rolled away from, so
 * the daily check won't re-offer the known-bad version — the moment
 * origin moves past it (presumably the fix), offers resume.
 */
export function recordRollback(args: { now: number; fromSha: string; toSha: string }): void {
  mutateUpdateMemory((m) => {
    m.declinedSha = args.fromSha;
    m.booting = null;
    m.applying = null;
    m.journal.push({ at: args.now, kind: "rollback", fromSha: args.fromSha, toSha: args.toSha });
  });
}

export function markBooting(sha: string, now: number): void {
  mutateUpdateMemory((m) => {
    m.booting = { sha, at: now, root: WT_REPO_ROOT };
  });
}

/** The boot proved healthy: promote to last-good, clear the sentinel. Idempotent. */
export function markBootGood(sha: string): void {
  mutateUpdateMemory((m) => {
    m.lastGoodSha = sha;
    if (m.booting?.sha === sha) m.booting = null;
  });
}

// ── Boot sentinel lifecycle (the TUI path in main.ts) ──────────────────

const BOOT_HEALTHY_MS = 15_000;

let bootSha: string | null = null;
let bootPromoted = false;

/**
 * Record that this version is starting and schedule its promotion to
 * "known good" after BOOT_HEALTHY_MS alive. The promotion fiber is scoped
 * to the TUI program, so failure interrupts it before the crash handler can
 * wait at a rollback prompt.
 */
export function armBootSentinelEffect(): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const head = yield* Effect.sync(() => gitSync(["rev-parse", "HEAD"]));
    if (!head) return;
    bootSha = head;
    bootPromoted = false;
    yield* Effect.sync(() => markBooting(head, Date.now()));
    yield* Effect.sleep(BOOT_HEALTHY_MS).pipe(
      Effect.andThen(Effect.sync(() => {
        bootPromoted = true;
        markBootGood(head);
      })),
      Effect.forkScoped,
    );
  });
}

/** Clean TUI exit before the health timer fired still counts as a healthy boot. */
export function completeBootSentinel(): void {
  if (bootSha && !bootPromoted) {
    bootPromoted = true;
    markBootGood(bootSha);
  }
}
