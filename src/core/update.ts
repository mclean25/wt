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
  acquireUpdateGitLockEffect,
  gitOkEffect,
  gitSync,
  logSafe,
  runInEffect,
  runInResultEffect,
  restartEventsDaemonAfterUpdateEffect,
  shortSha,
  spawnFreshWt,
  WT_REPO_ROOT,
  wtVersion,
  updateGitLockEffect,
} from "./update/exec.ts";
export type { EventsDaemonRestartResult } from "./update/exec.ts";
export {
  armBootSentinelEffect,
  completeBootSentinel,
  emptyUpdateMemory,
  parseUpdateMemory,
  readUpdateMemory,
  recordUpdateApplied,
  rememberUpdateCheck,
  rememberUpdateDecline,
} from "./update/memory.ts";
export type { UpdateJournalEntry, UpdateMemory } from "./update/memory.ts";
export {
  fetchWtOriginEffect,
  listRunningWtInstancesEffect,
  pendingCommitsEffect,
  repoUpdateStateEffect,
  selectOffer,
  startupCheckGate,
  UPDATE_CHECK_INTERVAL_MS,
} from "./update/state.ts";
export type { OfferDecision, PendingCommit, RepoUpdateState, StartupGate } from "./update/state.ts";
export {
  classifyCheckRuns,
  findNewestEligibleEffect,
  originGithubRepoEffect,
} from "./update/green.ts";
export type { CheckStatus, GateResult } from "./update/green.ts";
export {
  applyWtUpdateEffect,
  performRollbackEffect,
  smokeCheckoutEffect,
} from "./update/apply.ts";
export type { ApplyDependencies, ApplyResult } from "./update/apply.ts";
