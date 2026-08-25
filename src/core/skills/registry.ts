/**
 * The registry of everything `wt skills` distributes: the bundled
 * agent skills (source of truth: `<repo>/skills/<name>/SKILL.md`) and
 * the managed always-on instructions block (`<repo>/skills/
 * instructions.md`) spliced into each harness's global instructions
 * file. wt is the single source for all of it — `wt skills sync` and
 * the TUI startup check keep installed copies current from here.
 *
 * Template vars are the per-user blanks in bundled content: `{{key}}`
 * placeholders answered once (interactively, remembered forever in
 * skills-memory) and rendered at install time. Vars are declared here,
 * not scanned from content, so stray `{{…}}` in code samples is never
 * mangled. Keys are GLOBAL across units: two skills declaring the same
 * key share one answer (asked once).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TemplateVar = {
  /** Global answer key (also the skills-memory key). */
  key: string;
  /** Question shown when asking the human for a value. */
  prompt: string;
  /** Rendered when the answer is absent or empty. */
  fallback: string;
};

export type Unit = {
  kind: "skill" | "instructions";
  /** Skill name (= install dir name), or "instructions". */
  name: string;
  /** One-liner for prompts and `wt skills` listings. */
  summary: string;
  vars: readonly TemplateVar[];
};

/** Stable identity for decline memory and report rows. */
export function unitKey(u: Unit): string {
  return u.kind === "skill" ? `skill:${u.name}` : "instructions";
}

const PROJECT_NOTES: TemplateVar = {
  key: "project_notes",
  prompt:
    "Project-specific conventions for agents starting work (design-review flow, " +
    "testing tools/skills, tracker quirks). One line or a short sentence; empty for none",
  fallback:
    "(none configured — if project conventions are unclear, ask the human rather than guessing)",
};

/**
 * Bundled units, in display order. `instructions` first: it's the
 * always-on layer everything else assumes.
 */
export const UNITS: readonly Unit[] = [
  {
    kind: "instructions",
    name: "instructions",
    summary:
      "always-on agent rules (status, testing, dev-server ownership, manager messaging, merge edges) in your global instructions file",
    vars: [],
  },
  {
    kind: "skill",
    name: "wt",
    summary: "wt orientation: subcommands, conventions, stacked-PR model",
    vars: [],
  },
  {
    kind: "skill",
    name: "restack",
    summary: "conflict-resolution playbook for `wt restack`",
    vars: [],
  },
  {
    kind: "skill",
    name: "manager",
    summary: "playbook for the singleton manager (fleet-coordinator) session",
    vars: [],
  },
  {
    kind: "skill",
    name: "shepherd",
    summary: "drive the whole fleet toward mergeable on a loop, stopping short of the merge",
    vars: [],
  },
  {
    kind: "skill",
    name: "babysit",
    summary: "drive this worktree's own branch through review to mergeable",
    vars: [],
  },
  {
    kind: "skill",
    name: "start",
    summary: "kick off work inside a prepared worktree (brief → research → build → hand off)",
    vars: [PROJECT_NOTES],
  },
  {
    kind: "skill",
    name: "handoff",
    summary: "create a follow-up worktree, brief it, and start its primary agent",
    vars: [],
  },
  {
    kind: "skill",
    name: "triage",
    summary: "turn a task batch into prioritized, ready-to-work worktrees",
    vars: [PROJECT_NOTES],
  },
];

export function findUnit(name: string): Unit | null {
  return UNITS.find((u) => u.name === name) ?? null;
}

/** Bundled sources live in the wt checkout itself. */
const SKILLS_ROOT = join(import.meta.dir, "..", "..", "..", "skills");

export function unitSourcePath(u: Unit): string {
  return u.kind === "skill"
    ? join(SKILLS_ROOT, u.name, "SKILL.md")
    : join(SKILLS_ROOT, "instructions.md");
}

/** Raw (unrendered) source for a unit; null when the checkout lacks it. */
export function unitSource(u: Unit): string | null {
  const p = unitSourcePath(u);
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
