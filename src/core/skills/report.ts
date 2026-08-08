/**
 * Freshness computation: for every (unit × target), compare what IS
 * installed against what WOULD be installed from the current bundled
 * source + remembered answers. Pure fs reads — safe to run on every
 * TUI startup and from `wt doctor`.
 */
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { SkillsMemory } from "./memory.ts";
import { unitKey, unitSource, UNITS, type Unit } from "./registry.ts";
import { targetKey, type InstructionsTarget, type SkillsTarget, type Targets } from "./targets.ts";
import {
  contentHash,
  countInstructionsBlocks,
  extractInstructionsBlock,
  normalizeBody,
  renderTemplate,
  splitStamp,
  stripRulesyncKeys,
} from "./template.ts";

/**
 * Per-(unit, target) state:
 *  - `fresh`      installed content matches the current render exactly
 *  - `outdated`   an unmodified wt-managed copy of an older version
 *  - `modified`   a copy exists but isn't an intact wt-managed one
 *                 (user-edited, or a personal/pre-existing skill) —
 *                 never overwritten without an explicit yes
 *  - `missing`    nothing installed
 *  - `blocked`    can't manage this target (detail says why)
 */
export type UnitState = "fresh" | "outdated" | "modified" | "missing" | "blocked";

export type UnitReport = {
  unit: Unit;
  target: SkillsTarget | InstructionsTarget;
  state: UnitState;
  /** Hash of the canonical render (pre-native-transform); decline memory keys on it. */
  canonicalHash: string;
  /** File the state was computed from. */
  path: string;
  /** The exact content an apply would write at `path` (block body for instructions). */
  expected: string;
  /** Human context for `blocked`, or extra nuance for other states. */
  detail?: string;
  /** The current version was explicitly declined; suppress prompts. */
  declined: boolean;
};

export function reportIsActionable(r: UnitReport): boolean {
  return (
    !r.declined &&
    (r.state === "missing" || r.state === "outdated" || r.state === "modified")
  );
}

/**
 * Decline-memory key for one (unit, target). Per-target so a "no" for
 * a modified copy on one target never silently suppresses an install
 * to another (e.g. a harness configured after the decline).
 */
export function declineKey(unit: Unit, target: SkillsTarget | InstructionsTarget): string {
  return `${unitKey(unit)}::${targetKey(target)}`;
}

function isDeclined(
  memory: SkillsMemory,
  unit: Unit,
  target: SkillsTarget | InstructionsTarget,
  canonicalHash: string,
): boolean {
  // Legacy entries (pre-per-target) were keyed by unit alone; honor
  // them so existing machines don't get re-prompted for old declines.
  return (
    memory.declined[declineKey(unit, target)] === canonicalHash ||
    memory.declined[unitKey(unit)] === canonicalHash
  );
}

/** All reports for the machine, in registry × target order. */
export function buildReports(targets: Targets, memory: SkillsMemory): UnitReport[] {
  const out: UnitReport[] = [];
  for (const unit of UNITS) {
    const src = unitSource(unit);
    if (src === null) continue; // checkout missing the source; nothing to say
    const rendered = normalizeBody(renderTemplate(src, unit.vars, memory.answers));
    const canonicalHash = contentHash(rendered);
    if (unit.kind === "skill") {
      for (const target of targets.skills) {
        const declined = isDeclined(memory, unit, target, canonicalHash);
        out.push(skillReport(unit, target, rendered, canonicalHash, declined));
      }
    } else {
      for (const target of targets.instructions) {
        const declined = isDeclined(memory, unit, target, canonicalHash);
        out.push(instructionsReport(unit, target, rendered, canonicalHash, declined));
      }
    }
  }
  return out;
}

function readOr(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `<skills dir>/<name>/SKILL.md` for a target. */
export function skillInstallPath(unit: Unit, target: SkillsTarget): string {
  const dir = target.kind === "rulesync" ? target.rulesync.skillsDir : target.dir;
  return join(dir, unit.name, "SKILL.md");
}

function skillReport(
  unit: Unit,
  target: SkillsTarget,
  rendered: string,
  canonicalHash: string,
  declined: boolean,
): UnitReport {
  // Native installs strip rulesync-only frontmatter; the stamp/compare
  // must run on the SAME text that lands on disk.
  const expected =
    target.kind === "native" ? normalizeBody(stripRulesyncKeys(rendered)) : rendered;
  const path = skillInstallPath(unit, target);
  const base = { unit, target, canonicalHash, path, expected, declined };
  const installed = readOr(path);
  if (installed === null) return { ...base, state: "missing" };
  const { body, stamp } = splitStamp(installed);
  if (body === expected) return { ...base, state: "fresh" };
  if (stamp !== null && stamp === contentHash(body)) return { ...base, state: "outdated" };
  return {
    ...base,
    state: "modified",
    detail: stamp === null ? "existing copy was not installed by wt" : "edited after install",
  };
}

function instructionsReport(
  unit: Unit,
  target: InstructionsTarget,
  rendered: string,
  canonicalHash: string,
  declined: boolean,
): UnitReport {
  const blockBody = rendered.replace(/\n+$/, "");
  const base = { unit, target, canonicalHash, path: "", expected: blockBody, declined };
  if (target.kind === "rulesync" && target.rulesync.rootRuleFile === null) {
    return {
      ...base,
      path: join(target.rulesync.root, ".rulesync", "rules"),
      state: "blocked",
      detail: "no `root: true` rule file found to hold the managed block",
    };
  }
  const file = target.kind === "rulesync" ? target.rulesync.rootRuleFile! : target.file;
  const text = readOr(file);
  const withPath = { ...base, path: file };
  if (text === null) {
    // A dangling symlink is a topology statement (e.g. a dotfiles
    // checkout not present on this machine) — writing would silently
    // replace the link with a regular file. Refuse instead.
    if (isDanglingSymlink(file)) {
      return {
        ...withPath,
        state: "blocked",
        detail: "instructions file is a dangling symlink — fix the link target first",
      };
    }
    return { ...withPath, state: "missing" };
  }
  if (countInstructionsBlocks(text) > 1) {
    // Splice only ever operates on the FIRST block; applying here
    // would leave a stale duplicate un-managed. Refuse until fixed.
    return {
      ...withPath,
      state: "blocked",
      detail: "multiple managed blocks found — remove the duplicates by hand",
    };
  }
  const block = extractInstructionsBlock(text);
  if (block === null) return { ...withPath, state: "missing" };
  if (block.body === blockBody) return { ...withPath, state: "fresh" };
  if (block.hash === contentHash(block.body)) return { ...withPath, state: "outdated" };
  return { ...withPath, state: "modified", detail: "block edited after install" };
}

/** True when a symlink exists at `p` but its target does not. */
function isDanglingSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink() && !existsSync(p);
  } catch {
    return false;
  }
}
