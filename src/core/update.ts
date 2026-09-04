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
  acquireUpdateGitLock,
  gitOk,
  gitSync,
  logSafe,
  runIn,
  runInResult,
  shortSha,
  spawnFreshWt,
  WT_REPO_ROOT,
  wtVersion,
  updateGitLock,
} from "./update/exec.ts";
export type { RunResult } from "./update/exec.ts";
export {
  armBootSentinel,
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
  fetchWtOrigin,
  listRunningWtInstances,
  pendingCommits,
  repoUpdateState,
  selectOffer,
  startupCheckGate,
  UPDATE_CHECK_INTERVAL_MS,
} from "./update/state.ts";
export type { OfferDecision, PendingCommit, RepoUpdateState, StartupGate } from "./update/state.ts";
export {
  classifyCheckRuns,
  findNewestEligible,
  originGithubRepo,
} from "./update/green.ts";
export type { CheckStatus, GateResult } from "./update/green.ts";
export {
  applyWtUpdate,
  performRollback,
  smokeCheckout,
} from "./update/apply.ts";
export type { ApplyDependencies, ApplyResult } from "./update/apply.ts";
