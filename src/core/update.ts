/**
 * Barrel for the self-update system (`core/update/`). Everything under
 * it is deliberately config-free — the crash-rollback path must work
 * when `core/config.ts` is exactly what the broken update can't load.
 * Layers: `exec.ts` (spawn/git plumbing, version) → `memory.ts`
 * (journal, declines, boot sentinel) → `state.ts` (repo probes, pure
 * decisions) / `green.ts` (CI gate) → `apply.ts` (ff-update + smoke +
 * rollback). Semantics doc: docs/updates.md.
 */
export {
  gitSync,
  logSafe,
  resetWtVersionCache,
  shortSha,
  WT_REPO_ROOT,
  wtVersion,
} from "./update/exec.ts";
export {
  emptyUpdateMemory,
  markBooting,
  markBootGood,
  parseUpdateMemory,
  readUpdateMemory,
  recordRollback,
  recordUpdateApplied,
  rememberUpdateCheck,
  rememberUpdateDecline,
  UPDATE_MEMORY_FILE,
} from "./update/memory.ts";
export type { UpdateJournalEntry, UpdateMemory } from "./update/memory.ts";
export {
  fetchWtOrigin,
  listRunningWtInstances,
  pendingCommits,
  repoUpdateState,
  selectOffer,
  startupCheckGate,
  UPDATE_CHECK_INTERVAL_MS,
} from "./update/state.ts";
export type { OfferDecision, PendingCommit, RepoUpdateState, StartupGate } from "./update/state.ts";
export { classifyCheckRuns, findNewestEligible, GATE_CHECK_NAMES, originGithubRepo } from "./update/green.ts";
export type { CheckStatus, GateResult } from "./update/green.ts";
export { applyWtUpdate, performRollback, smokeCheckout } from "./update/apply.ts";
export type { ApplyResult } from "./update/apply.ts";
