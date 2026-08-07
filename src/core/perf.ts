/**
 * Performance instrumentation. Two unrelated tools that happen to share
 * the subject:
 *
 *  - `loop-lag.ts` — the opt-in (`WT_PERF=1`) event-loop-lag probe. Answers
 *    "why does j/k feel laggy", i.e. is *wt's own render thread* blocked.
 *  - `sample.ts` — the process/CPU sampler behind the `P` overlay. Answers
 *    "why does the machine feel slow", i.e. is anything downstream of wt
 *    eating the box.
 *
 * Split into a directory behind this flat barrel per the module-layout
 * convention in docs/architecture.md; importers keep using `core/perf.ts`.
 */

export { startLoopLagProbe } from "./perf/loop-lag.ts";

export {
  buildPerfInvestigationPrompt,
  CATEGORY_LABEL,
  classifyProcess,
  formatPerfReport,
  PERF_CATEGORIES,
  samplePerf,
  shortCommand,
} from "./perf/sample.ts";
export type {
  PerfBucket,
  PerfCategory,
  PerfProc,
  PerfSession,
  PerfSnapshot,
} from "./perf/sample.ts";
