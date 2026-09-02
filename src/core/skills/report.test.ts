/**
 * End-to-end freshness/apply tests against real temp filesystems,
 * including the symlink + rulesync topologies detection must handle
 * (a stow-style dotfiles layout where every harness resolves into one
 * rulesync-generated tree).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

import { applyReportPromise, touchedRulesyncRoots } from "./apply.ts";
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

function findReport(reports: UnitReport[], unit: Unit): UnitReport {
  const r = reports.find((x) => x.unit === unit);
  expect(r).toBeDefined();
  return r!;
}

describe("native claude-only machine", () => {
  beforeEach(() => {
    mkdirSync(join(home, ".claude"), { recursive: true });
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
    applyReportPromise(first);
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
    applyReportPromise(r);
    const text = readFileSync(claudeMd, "utf8");
    expect(text).toContain("keep me");
    expect(extractInstructionsBlock(text)?.body).toBe(r.expected);
    expect(findReport(reportsFor(), INSTRUCTIONS_UNIT).state).toBe("fresh");
  });

  test("instructions file absent entirely still applies (creates it)", () => {
    const r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    expect(r.state).toBe("missing");
    applyReportPromise(r);
    expect(existsSync(join(home, ".claude", "CLAUDE.md"))).toBe(true);
    expect(findReport(reportsFor(), INSTRUCTIONS_UNIT).state).toBe("fresh");
  });
});

describe("stow-style rulesync machine (all harnesses one real tree)", () => {
  let dotfiles: string;

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
    mkdirSync(join(home, ".claude"));
    symlinkSync(join(dotfiles, "ai", ".claude", "skills"), join(home, ".claude", "skills"));
    symlinkSync(join(dotfiles, "ai", ".claude", "AGENTS.md"), join(home, ".claude", "CLAUDE.md"));
    mkdirSync(join(home, ".codex"));
    symlinkSync(join(dotfiles, "ai", ".claude", "AGENTS.md"), join(home, ".codex", "AGENTS.md"));
    symlinkSync(join(dotfiles, "ai", ".claude"), join(home, ".agents"));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    symlinkSync(
      join(dotfiles, "ai", ".claude", "AGENTS.md"),
      join(home, ".config", "opencode", "AGENTS.md"),
    );
  });

  test("all three harnesses dedupe to ONE rulesync target each way", () => {
    const targets = detectTargets(home, {});
    expect(targets.harnesses).toEqual(["claude", "codex", "opencode"]);
    expect(targets.skills).toHaveLength(1);
    expect(targets.skills[0]!.kind).toBe("rulesync");
    expect([...targets.skills[0]!.harnesses].sort()).toEqual(["claude", "codex", "opencode"]);
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
    applyReportPromise(r);
    const installed = readFileSync(r.path, "utf8");
    expect(installed).toContain("targets:");
    expect(findReport(reportsFor(), WT_UNIT).state).toBe("fresh");
    expect(touchedRulesyncRoots([r])).toHaveLength(1);
  });

  test("instructions block goes into the root rule source file", () => {
    const r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    expect(r.path).toBe(join(dotfiles, ".rulesync", "rules", "CLAUDE.md"));
    applyReportPromise(r);
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
    mkdirSync(join(home, ".codex"), { recursive: true });
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
    mkdirSync(join(home, ".claude"), { recursive: true });
    symlinkSync(join(home, "not-cloned-yet", "CLAUDE.md"), join(home, ".claude", "CLAUDE.md"));
    const r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    expect(r.state).toBe("blocked");
    expect(r.detail).toContain("dangling symlink");
    expect(reportIsActionable(r)).toBe(false);
  });

  test("duplicate managed blocks are blocked with a hand-fix hint", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const claudeMd = join(home, ".claude", "CLAUDE.md");
    writeFileSync(claudeMd, "x\n");
    const r = findReport(reportsFor(), INSTRUCTIONS_UNIT);
    applyReportPromise({ ...r, path: claudeMd });
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
    applyReportPromise(r);
    expect(existsSync(stale)).toBe(false);
    expect(findReport(reportsFor(), WT_UNIT).state).toBe("fresh");
  });
});

describe("template vars flow through hashing", () => {
  test("answering a var changes the canonical hash (re-arms declines)", () => {
    mkdirSync(join(home, ".claude"), { recursive: true });
    const start = UNITS.find((u) => u.name === "start")!;
    const before = findReport(reportsFor(), start);
    const mem = emptySkillsMemory();
    mem.answers.project_notes = "Design reviews go through /grill.";
    const after = findReport(reportsFor(mem), start);
    expect(before.canonicalHash).not.toBe(after.canonicalHash);
    expect(after.expected).toContain("Design reviews go through /grill.");
  });
});
