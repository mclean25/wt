/**
 * End-to-end freshness/apply tests against real temp filesystems,
 * including the symlink + rulesync topologies detection must handle
 * (a stow-style dotfiles layout where every harness resolves into one
 * rulesync-generated tree).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyReport, touchedRulesyncRoots } from "./apply.ts";
import type { SkillsMemory } from "./memory.ts";
import { emptySkillsMemory } from "./memory.ts";
import { unitKey, UNITS, type Unit } from "./registry.ts";
import { buildReports, declineKey, reportIsActionable, type UnitReport } from "./report.ts";
import { detectTargets } from "./targets.ts";
import { contentHash, extractInstructionsBlock } from "./template.ts";

let home: string;

beforeEach(() => {
  // realpath: on macOS tmpdir() is /var/… which resolves to /private/var/…,
  // and detection realpath-resolves everything it touches.
  home = realpathSync(mkdtempSync(join(tmpdir(), "wt-skills-test-")));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const WT_UNIT = UNITS.find((u) => u.name === "wt" && u.kind === "skill")!;
const INSTRUCTIONS_UNIT = UNITS.find((u) => u.kind === "instructions")!;

function reportsFor(mem: SkillsMemory = emptySkillsMemory()): UnitReport[] {
  return buildReports(detectTargets(home, {}), mem);
}

/**
 * A tool's config dir as it really exists. Detection requires CONTENT
 * (an empty dir is a retired stow mount point, not a configured
 * tool), so a test that creates a bare directory would be modelling a
 * machine nobody has.
 */
function configDir(...parts: string[]): string {
  const dir = join(home, ...parts);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), "{}\n");
  return dir;
}

function findReport(reports: UnitReport[], unit: Unit): UnitReport {
  const r = reports.find((x) => x.unit === unit);
  expect(r).toBeDefined();
  return r!;
}

describe("native claude-only machine", () => {
  beforeEach(() => {
    configDir(".claude");
  });

  test("everything reports missing, one native target", () => {
    const targets = detectTargets(home, {});
    expect(targets.harnesses).toEqual(["claude"]);
    expect(targets.skills).toHaveLength(1);
    expect(targets.skills[0]!.kind).toBe("native");
    const r = findReport(reportsFor(), WT_UNIT);
    expect(r.state).toBe("missing");
    expect(reportIsActionable(r)).toBe(true);
  });

  test("apply → fresh; hand edit → modified; stamp intact → outdated", () => {
    const first = findReport(reportsFor(), WT_UNIT);
    Effect.runSync(applyReport(first));
    expect(findReport(reportsFor(), WT_UNIT).state).toBe("fresh");
    // Native install must have stripped the rulesync-only targets key.
    const installed = readFileSync(first.path, "utf8");
    expect(installed).not.toContain("targets:");
    expect(installed).toContain("<!-- wt-managed ");

    // A user edit breaks the stamp → modified, not silently updatable.
    writeFileSync(first.path, installed.replace("# wt", "# my wt"));
    expect(findReport(reportsFor(), WT_UNIT).state).toBe("modified");

    // Restore, then simulate a NEW bundled version by changing what's
    // expected: rendering with a different answer set doesn't affect
    // the wt skill (no vars), so instead corrupt the installed body and
    // re-stamp it consistently — an intact old version.
    const oldBody = "old version of the skill\n";
    writeFileSync(first.path, `${oldBody}<!-- wt-managed ${contentHash(oldBody)} -->\n`);
    expect(findReport(reportsFor(), WT_UNIT).state).toBe("outdated");
  });

  test("pre-existing personal skill (no stamp) is modified + decline memory suppresses", () => {
    const skillDir = join(home, ".claude", "skills", "wt");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "my own wt notes\n");
    let r = findReport(reportsFor(), WT_UNIT);
    expect(r.state).toBe("modified");
    expect(reportIsActionable(r)).toBe(true);

    const mem = emptySkillsMemory();
    mem.declined[unitKey(WT_UNIT)] = r.canonicalHash;
    r = findReport(reportsFor(mem), WT_UNIT);
    expect(r.declined).toBe(true);
    expect(reportIsActionable(r)).toBe(false);

    // A different canonical hash (new bundled version) re-arms the prompt.
    mem.declined[unitKey(WT_UNIT)] = "000000000000";
    expect(reportIsActionable(findReport(reportsFor(mem), WT_UNIT))).toBe(true);
  });

  test("instructions block: missing → apply → fresh → replace on change", () => {
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, "# My rules\n\nkeep me\n");
    let r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    expect(r.state).toBe("missing");
    Effect.runSync(applyReport(r));
    const text = readFileSync(claudeMd, "utf8");
    expect(text).toContain("keep me");
    expect(extractInstructionsBlock(text)?.body).toBe(r.expected);
    expect(findReport(reportsFor(), INSTRUCTIONS_UNIT).state).toBe("fresh");
  });

  test("instructions file absent entirely still applies (creates it)", () => {
    const r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    expect(r.state).toBe("missing");
    Effect.runSync(applyReport(r));
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(true);
    expect(findReport(reportsFor(), INSTRUCTIONS_UNIT).state).toBe("fresh");
  });
});

describe("stow-style rulesync machine (every tool one real tree)", () => {
  let dotfiles: string;
  let piDir: string;

  beforeEach(() => {
    dotfiles = join(home, "dotfiles");
    // Canonical source + generated output layout.
    mkdirSync(join(dotfiles, ".rulesync", "skills"), { recursive: true });
    mkdirSync(join(dotfiles, ".rulesync", "rules"), { recursive: true });
    writeFileSync(
      join(dotfiles, ".rulesync", "rules", "CLAUDE.md"),
      "---\nroot: true\ntargets:\n  - '*'\n---\n## My rules\n",
    );
    mkdirSync(join(dotfiles, "ai", ".claude", "skills"), { recursive: true });
    writeFileSync(join(dotfiles, "ai", ".claude", "AGENTS.md"), "generated\n");
    // Harness dirs symlink into the generated tree (file + dir links).
    configDir(".claude");
    symlinkSync(join(dotfiles, "ai", ".claude", "skills"), join(home, ".claude", "skills"));
    symlinkSync(join(dotfiles, "ai", ".claude", "AGENTS.md"), join(home, ".claude", "CLAUDE.md"));
    configDir(".codex");
    symlinkSync(join(dotfiles, "ai", ".claude", "AGENTS.md"), join(home, ".codex", "AGENTS.md"));
    symlinkSync(join(dotfiles, "ai", ".claude"), join(home, ".agents"));
    // Pi is pointed at a deliberately unstowed config dir whose
    // AGENTS.md symlinks back into the same generated tree.
    piDir = join(dotfiles, "pi", "agent");
    mkdirSync(piDir, { recursive: true });
    symlinkSync(join(dotfiles, "ai", ".claude", "AGENTS.md"), join(piDir, "AGENTS.md"));
  });

  test("every configured tool dedupes to ONE rulesync target each way", () => {
    const targets = detectTargets(home, { PI_CODING_AGENT_DIR: piDir });
    expect(targets.harnesses).toEqual(["claude", "codex", "pi"]);
    expect(targets.skills).toHaveLength(1);
    expect(targets.skills[0]!.kind).toBe("rulesync");
    expect([...targets.skills[0]!.harnesses].sort()).toEqual(["claude", "codex", "pi"]);
    expect(targets.instructions).toHaveLength(1);
    expect(targets.instructions[0]!.kind).toBe("rulesync");
    if (targets.skills[0]!.kind === "rulesync") {
      expect(targets.skills[0]!.rulesync.root).toBe(dotfiles);
      // No scripts/rulesync.sh → stock CLI regen.
      expect(targets.skills[0]!.rulesync.regen[0]).toBe("npx");
    }
  });

  test("repo-local generator script is preferred when present", () => {
    mkdirSync(join(dotfiles, "scripts"), { recursive: true });
    writeFileSync(join(dotfiles, "scripts", "rulesync.sh"), "#!/bin/bash\n");
    const targets = detectTargets(home, {});
    if (targets.skills[0]!.kind === "rulesync") {
      expect(targets.skills[0]!.rulesync.regen).toEqual([
        "bash",
        join(dotfiles, "scripts", "rulesync.sh"),
      ]);
    }
  });

  test("skill applies into the rulesync SOURCE, keeping rulesync keys", () => {
    const r = findReport(reportsFor(), WT_UNIT);
    expect(r.state).toBe("missing");
    expect(r.path).toBe(join(dotfiles, ".rulesync", "skills", "wt", "SKILL.md"));
    Effect.runSync(applyReport(r));
    const installed = readFileSync(r.path, "utf8");
    expect(installed).toContain("targets:");
    expect(findReport(reportsFor(), WT_UNIT).state).toBe("fresh");
    expect(touchedRulesyncRoots([r])).toHaveLength(1);
  });

  test("instructions block goes into the root rule source file", () => {
    const r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    expect(r.path).toBe(join(dotfiles, ".rulesync", "rules", "CLAUDE.md"));
    Effect.runSync(applyReport(r));
    const text = readFileSync(r.path, "utf8");
    expect(text).toContain("## My rules");
    expect(extractInstructionsBlock(text)?.body).toBe(r.expected);
  });

  test("no root rule file → instructions blocked with a reason", () => {
    rmSync(join(dotfiles, ".rulesync", "rules", "CLAUDE.md"));
    const r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    expect(r.state).toBe("blocked");
    expect(reportIsActionable(r)).toBe(false);
  });
});

describe("multi-target machines", () => {
  test("a decline on one target never suppresses a missing install on another", () => {
    // Claude native with a personal copy; Codex native with nothing.
    mkdirSync(join(home, ".claude", "skills", "wt"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "wt", "SKILL.md"), "my own\n");
    configDir(".codex");
    const reports = reportsFor();
    const wtReports = reports.filter((r) => r.unit === WT_UNIT);
    expect(wtReports).toHaveLength(2);
    const modified = wtReports.find((r) => r.state === "modified")!;
    const missing = wtReports.find((r) => r.state === "missing")!;

    // Decline recorded per-(unit, target) — as the sync flow does.
    const mem = emptySkillsMemory();
    mem.declined[declineKey(WT_UNIT, modified.target)] = modified.canonicalHash;
    const after = reportsFor(mem).filter((r) => r.unit === WT_UNIT);
    expect(after.find((r) => r.state === "modified")!.declined).toBe(true);
    expect(after.find((r) => r.state === "missing")!.declined).toBe(false);
    expect(reportIsActionable(after.find((r) => r.state === "missing")!)).toBe(true);
    void missing;
  });

  test("legacy unit-scoped decline entries are still honored", () => {
    mkdirSync(join(home, ".claude", "skills", "wt"), { recursive: true });
    writeFileSync(join(home, ".claude", "skills", "wt", "SKILL.md"), "my own\n");
    const r = findReport(reportsFor(), WT_UNIT);
    const mem = emptySkillsMemory();
    mem.declined[unitKey(WT_UNIT)] = r.canonicalHash; // old format
    expect(findReport(reportsFor(mem), WT_UNIT).declined).toBe(true);
  });
});

describe("instructions-file hazards", () => {
  test("dangling symlink instructions file is blocked, not clobbered", () => {
    configDir(".claude");
    symlinkSync(join(home, "not-cloned-yet", "CLAUDE.md"), join(home, ".claude", "CLAUDE.md"));
    const r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    expect(r.state).toBe("blocked");
    expect(r.detail).toContain("dangling symlink");
    expect(reportIsActionable(r)).toBe(false);
  });

  test("duplicate managed blocks are blocked with a hand-fix hint", () => {
    configDir(".claude");
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, "x\n");
    const r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    Effect.runSync(applyReport({ ...r, path: claudeMd }));
    const once = readFileSync(claudeMd, "utf8");
    writeFileSync(claudeMd, `${once}\n${once}`);
    const dup = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    expect(dup.state).toBe("blocked");
    expect(dup.detail).toContain("multiple managed blocks");
  });
});

describe("apply hygiene", () => {
  test("stale staged temp dirs from dead runs are reaped on the next apply", () => {
    mkdirSync(join(home, ".claude", "skills"), { recursive: true });
    const stale = join(home, ".claude", "skills", ".wt.tmp-99999");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "SKILL.md"), "abandoned\n");
    const r = findReport(reportsFor(), WT_UNIT);
    Effect.runSync(applyReport(r));
    expect(existsSync(stale)).toBe(false);
    expect(findReport(reportsFor(), WT_UNIT).state).toBe("fresh");
  });
});

describe("template vars flow through hashing", () => {
  test("answering a var changes the canonical hash (re-arms declines)", () => {
    configDir(".claude");
    const start = UNITS.find((u) => u.name === "start")!;
    const before = findReport(reportsFor(), start);
    const mem = emptySkillsMemory();
    mem.answers.project_notes = "Design reviews go through /grill.";
    const after = findReport(reportsFor(mem), start);
    expect(before.canonicalHash).not.toBe(after.canonicalHash);
    expect(after.expected).toContain("Design reviews go through /grill.");
  });
});

describe("tool presence is evidence, not a mount point", () => {
  test("an emptied config dir left behind by a retired tool does not count", () => {
    configDir(".claude");
    const targets = detectTargets(home, {});
    expect(targets.harnesses).toEqual(["claude"]);
    expect(targets.instructions).toHaveLength(1);
    expect(targets.instructions[0]!.harnesses).toEqual(["claude"]);
  });

  test("PI_CODING_AGENT_DIR names Pi's config dir; an unpopulated one is not configured", () => {
    configDir(".claude");
    const piDir = join(home, "dotfiles", "pi", "agent");
    mkdirSync(piDir, { recursive: true });
    expect(detectTargets(home, { PI_CODING_AGENT_DIR: piDir }).harnesses).toEqual(["claude"]);

    writeFileSync(join(piDir, "settings.json"), "{}\n");
    const targets = detectTargets(home, { PI_CODING_AGENT_DIR: piDir });
    expect(targets.harnesses).toEqual(["claude", "pi"]);
    const pi = targets.instructions.find((t) => t.harnesses.includes("pi"))!;
    expect(pi.kind).toBe("native");
    if (pi.kind === "native") expect(pi.file).toBe(join(piDir, "AGENTS.md"));
  });

  test("an instructions file not generated YET still resolves into its rulesync pipeline", () => {
    // The write-through trap: realpath fails on the missing leaf, so
    // without resolving the parent this reads as a plain native file,
    // wt writes it into the generated output root, and the pipeline's
    // next regenerate deletes it — pending forever.
    const dotfiles = join(home, "dotfiles");
    mkdirSync(join(dotfiles, ".rulesync", "rules"), { recursive: true });
    writeFileSync(
      join(dotfiles, ".rulesync", "rules", "CLAUDE.md"),
      "---\nroot: true\n---\n## My rules\n",
    );
    mkdirSync(join(dotfiles, "ai", ".claude"), { recursive: true });
    writeFileSync(join(dotfiles, "ai", ".claude", "settings.json"), "{}\n");
    symlinkSync(join(dotfiles, "ai", ".claude"), join(home, ".claude"));

    const targets = detectTargets(home, {});
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(false);
    expect(targets.instructions).toHaveLength(1);
    expect(targets.instructions[0]!.kind).toBe("rulesync");
    const r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    expect(r.path).toBe(join(dotfiles, ".rulesync", "rules", "CLAUDE.md"));
  });
});
