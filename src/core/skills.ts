/**
 * Flat barrel for the skills-distribution system (`core/skills/`).
 * wt is the single source of wt-related agent skills + instructions;
 * this module detects where they live on the machine (harness dirs,
 * symlink topologies, rulesync pipelines), reports freshness, and
 * applies updates. Interactive flows (prompts) live CLI-side in
 * `cli/skills-sync.ts`; everything here is non-interactive.
 */
export {
  findUnit,
  unitKey,
  unitSource,
  unitSourcePath,
  UNITS,
  type TemplateVar,
  type Unit,
} from "./skills/registry.ts";
export {
  contentHash,
  countInstructionsBlocks,
  extractInstructionsBlock,
  normalizeBody,
  renderTemplate,
  spliceInstructionsBlock,
  splitStamp,
  stampContent,
  stripRulesyncKeys,
} from "./skills/template.ts";
export {
  detectTargets,
  findRulesyncRoot,
  targetKey,
  type HarnessId,
  type InstructionsTarget,
  type RulesyncInfo,
  type SkillsTarget,
  type Targets,
} from "./skills/targets.ts";
export {
  clearSkillsMemory,
  readSkillsMemory,
  rememberAnswer,
  rememberDecline,
  SKILLS_MEMORY_FILE,
  type SkillsMemory,
} from "./skills/memory.ts";
export {
  buildReports,
  declineKey,
  reportIsActionable,
  skillInstallPath,
  type UnitReport,
  type UnitState,
} from "./skills/report.ts";
export {
  applyReport,
  applyReportPromise,
  regenRulesync,
  regenRulesyncPromise,
  touchedRulesyncRoots,
  type RegenResult,
} from "./skills/apply.ts";
