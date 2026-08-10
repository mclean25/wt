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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { logSafe } from "./exec.ts";

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
  /** Set when a TUI boot starts, cleared when it proves healthy. A
   *  leftover entry on the next launch is crash evidence. */
  booting: { sha: string; at: number } | null;
  /** Applied updates and rollbacks, newest last. Capped. */
  journal: UpdateJournalEntry[];
};

const JOURNAL_CAP = 50;

export function emptyUpdateMemory(): UpdateMemory {
  return { lastCheckAt: null, declinedSha: null, lastGoodSha: null, booting: null, journal: [] };
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
    if (sha && at !== null) out.booting = { sha, at };
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

function mutateUpdateMemory(fn: (mem: UpdateMemory) => void): void {
  const mem = readUpdateMemory();
  fn(mem);
  if (mem.journal.length > JOURNAL_CAP) {
    mem.journal = mem.journal.slice(mem.journal.length - JOURNAL_CAP);
  }
  mkdirSync(dirname(UPDATE_MEMORY_FILE), { recursive: true });
  const tmp = `${UPDATE_MEMORY_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(mem, null, 2)}\n`);
  renameSync(tmp, UPDATE_MEMORY_FILE);
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

/** A successful update: journal it and clear any stale decline. */
export function recordUpdateApplied(args: { now: number; fromSha: string; toSha: string }): void {
  mutateUpdateMemory((m) => {
    m.lastCheckAt = args.now;
    m.declinedSha = null;
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
    m.journal.push({ at: args.now, kind: "rollback", fromSha: args.fromSha, toSha: args.toSha });
  });
}

export function markBooting(sha: string, now: number): void {
  mutateUpdateMemory((m) => {
    m.booting = { sha, at: now };
  });
}

/** The boot proved healthy: promote to last-good, clear the sentinel. Idempotent. */
export function markBootGood(sha: string): void {
  mutateUpdateMemory((m) => {
    m.lastGoodSha = sha;
    if (m.booting?.sha === sha) m.booting = null;
  });
}
