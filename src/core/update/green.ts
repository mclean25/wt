/**
 * The green-main gate: instead of offering origin's raw head, the
 * updater targets the NEWEST commit whose CI passed — main stays the
 * release channel, GitHub Actions provides the "was this push sane"
 * signal for free. Config-free (see exec.ts); uses the unauthenticated
 * GitHub API, which allows 60 req/hr/IP on public repos — plenty for a
 * once-a-day check capped at MAX_LOOKUPS commits.
 *
 * Fail-open by design: no GitHub origin, API unreachable, rate-limited,
 * or a commit with NO matching check runs (pre-CI history, forks) all
 * count as eligible — the gate must never strand a user on an old
 * version because GitHub hiccuped. Only an explicit "our CI failed or
 * is still running" verdict makes a commit ineligible. Check runs are
 * matched by name (GATE_CHECK_NAMES) so unrelated workflows — e.g. a
 * scheduled digest that fails during a GitHub outage — can't veto an
 * update.
 */
import { Effect } from "effect";

import { operationErrors } from "../errors.ts";
import { gitOk, logSafe } from "./exec.ts";

const io = operationErrors("update/green");

/** Check-run names that gate updates: the ci.yml job (and its typecheck-only predecessor). */
export const GATE_CHECK_NAMES: ReadonlySet<string> = new Set(["ci", "typecheck"]);

/** How many candidate commits (newest first) to interrogate before giving up. */
const MAX_LOOKUPS = 10;

const API_TIMEOUT_MS = 5_000;

export type CheckStatus = "green" | "red" | "pending" | "unknown";

/** `owner/repo` of the clone's GitHub origin, or null (gate disabled). */
export const originGithubRepo: Effect.Effect<{
  owner: string;
  repo: string;
} | null> = gitOk(["remote", "get-url", "origin"]).pipe(
  Effect.map((url) => {
    if (!url) return null;
    const match = url.match(
      /github(?:\.com)?[^:/]*[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
    );
    return match?.[1] && match[2]
      ? { owner: match[1], repo: match[2] }
      : null;
  }),
);

/**
 * Classify a check-runs API payload for one commit. Pure — the shape
 * is the GitHub REST `listForRef` response (`check_runs: [{name,
 * status, conclusion}]`).
 */
export function classifyCheckRuns(payload: unknown): CheckStatus {
  const runs = (payload as { check_runs?: unknown })?.check_runs;
  if (!Array.isArray(runs)) return "unknown";
  // Aggregate per gate name: one sha can carry several runs of the same
  // name (push + pull_request contexts, manual re-runs). A success in
  // ANY context means the code passed that check — only a name whose
  // every run completed without passing reds the commit. First-match
  // logic here once meant a flaky PR-context failure could permanently
  // strand a commit whose push-context run was green.
  const byName = new Map<string, { success: boolean; pending: boolean }>();
  for (const raw of runs) {
    const run = raw as { name?: unknown; status?: unknown; conclusion?: unknown };
    if (typeof run?.name !== "string" || !GATE_CHECK_NAMES.has(run.name)) continue;
    const agg = byName.get(run.name) ?? { success: false, pending: false };
    if (run.status !== "completed") agg.pending = true;
    else if (run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped") {
      agg.success = true;
    }
    byName.set(run.name, agg);
  }
  if (byName.size === 0) return "unknown";
  let pending = false;
  for (const agg of byName.values()) {
    if (agg.success) continue;
    if (agg.pending) {
      pending = true;
      continue;
    }
    return "red";
  }
  return pending ? "pending" : "green";
}

function fetchCheckStatus(
  owner: string,
  repo: string,
  sha: string,
  fetchImpl: typeof fetch,
): Effect.Effect<CheckStatus> {
  return io.promise(`check-runs fetch (${sha})`, (signal) =>
    fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "wt-updater",
        },
        signal,
      },
    ),
  ).pipe(
    Effect.timeout(`${API_TIMEOUT_MS} millis`),
    Effect.flatMap((response) => {
      if (!response.ok) {
        return Effect.sync(() => {
          logSafe(
            "warn",
            `check-runs API ${response.status} for ${sha} — gate falling open`,
          );
          return "unknown" as const;
        });
      }
      return io.promise(`check-runs parse (${sha})`, () => response.json())
        .pipe(Effect.map(classifyCheckRuns));
    }),
    Effect.catch((error) =>
      Effect.sync(() => {
        logSafe("warn", `check-runs fetch failed for ${sha}: ${error.message}`);
        return "unknown" as const;
      }),
    ),
  );
}

export type GateResult = {
  /** Newest eligible sha, or null when every interrogated candidate was red/pending. */
  target: string | null;
  /** What the gate saw, newest first — for `wt update`'s explanation when it holds back. */
  checked: { sha: string; status: CheckStatus }[];
  /** False when the gate didn't actually consult CI (no GitHub origin). */
  gated: boolean;
};

/**
 * Pick the newest eligible sha from `candidates` (newest first —
 * `pendingCommits` order). Eligible = green or unknown (fail-open);
 * red and pending are skipped. Stops at the first eligible hit, so the
 * common case costs one API call.
 */
export const findNewestEligible = Effect.fn("findNewestEligible")(function* (
  candidates: string[],
  fetchImpl: typeof fetch = fetch,
): Effect.fn.Return<GateResult> {
  if (candidates.length === 0) {
    return { target: null, checked: [], gated: false };
  }
  const origin = yield* originGithubRepo;
  if (!origin) {
    return { target: candidates[0] ?? null, checked: [], gated: false };
  }
  const checked: { sha: string; status: CheckStatus }[] = [];
  for (const sha of candidates.slice(0, MAX_LOOKUPS)) {
    const status = yield* fetchCheckStatus(
      origin.owner,
      origin.repo,
      sha,
      fetchImpl,
    );
    checked.push({ sha, status });
    if (status === "green" || status === "unknown") {
      return { target: sha, checked, gated: true };
    }
  }
  return { target: null, checked, gated: true };
});
