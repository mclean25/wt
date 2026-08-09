/**
 * Persistent machine-level memory for the skills system:
 *   - `answers`: template-var answers, keyed by var key. Asked once,
 *     remembered forever (until `wt skills reset`). An empty string is
 *     a real answer ("use the fallback, stop asking").
 *   - `declined`: per-unit "no thanks" records, keyed by unit key with
 *     the CANONICAL content hash that was declined. A new bundled
 *     version changes the hash, so declining never silences future
 *     updates — only re-prompts for the same content.
 *
 * Deliberately pinned to `~/.cache/wt` rather than the config's cache
 * root: the skills system's TARGETS are machine-global (`~/.claude`
 * skills, template answers like the user's name), so its memory must
 * be shared too — a second isolated instance (own cache_db) should not
 * re-ask questions the first already answered about the same global
 * files. Same write discipline as wtstate: atomic rename for readers,
 * a flock around read-modify-write for concurrent writers. The lock
 * file sits BESIDE this shared file (withFileLockAt), not in the
 * per-instance lockDir — two isolated instances have different
 * lockDirs, and a lockDir-keyed lock would let their read-modify-
 * writes interleave and silently drop one side's update.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { withFileLockAt } from "../locks.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("[skills]");

export const SKILLS_MEMORY_FILE = join(homedir(), ".cache", "wt", "skills.json");

export type SkillsMemory = {
  answers: Record<string, string>;
  declined: Record<string, string>;
};

export function emptySkillsMemory(): SkillsMemory {
  return { answers: {}, declined: {} };
}

export function parseSkillsMemory(raw: unknown): SkillsMemory {
  const data = raw as Partial<SkillsMemory> | null;
  const out = emptySkillsMemory();
  if (data?.answers && typeof data.answers === "object") {
    for (const [k, v] of Object.entries(data.answers)) {
      if (typeof v === "string") out.answers[k] = v;
    }
  }
  if (data?.declined && typeof data.declined === "object") {
    for (const [k, v] of Object.entries(data.declined)) {
      if (typeof v === "string") out.declined[k] = v;
    }
  }
  return out;
}

export function readSkillsMemory(): SkillsMemory {
  if (!existsSync(SKILLS_MEMORY_FILE)) return emptySkillsMemory();
  try {
    return parseSkillsMemory(JSON.parse(readFileSync(SKILLS_MEMORY_FILE, "utf8")));
  } catch (err) {
    log.error(err instanceof Error ? err : String(err), { file: SKILLS_MEMORY_FILE });
    return emptySkillsMemory();
  }
}

function writeSkillsMemory(mem: SkillsMemory): void {
  mkdirSync(dirname(SKILLS_MEMORY_FILE), { recursive: true });
  const tmp = `${SKILLS_MEMORY_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(mem, null, 2)}\n`);
  renameSync(tmp, SKILLS_MEMORY_FILE);
}

export function updateSkillsMemory(fn: (mem: SkillsMemory) => void): SkillsMemory {
  return withFileLockAt(`${SKILLS_MEMORY_FILE}.lock`, () => {
    const mem = readSkillsMemory();
    fn(mem);
    writeSkillsMemory(mem);
    return mem;
  });
}

export function rememberAnswer(key: string, value: string): void {
  updateSkillsMemory((m) => {
    m.answers[key] = value;
  });
}

export function rememberDecline(unitKey: string, hash: string): void {
  updateSkillsMemory((m) => {
    m.declined[unitKey] = hash;
  });
}

export function clearSkillsMemory(opts: { answers: boolean; declines: boolean }): void {
  updateSkillsMemory((m) => {
    if (opts.answers) m.answers = {};
    if (opts.declines) m.declined = {};
  });
}
