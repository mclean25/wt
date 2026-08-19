import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import { chainSignal, run, type RunResult } from "../proc.ts";
import type { MergeQueueEntry, PullRequest } from "../types.ts";
import { listWorktrees } from "../worktree.ts";
import { hasGh, repoSlug } from "./gh-cli.ts";
import { nodeToPr } from "./parse.ts";
import type { GithubData, GqlResponse } from "./types.ts";

const log = createLogger("[gh]");

/** First non-empty line, trimmed — gh failure bodies are multiline. */
function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}

// Invariant: the github source is ONE batched fetch. Every per-worktree
// PR field (state, checks, reviews, requested + suggested reviewers, ...)
// rides the same aliased query below, alongside the repo mergeQueue
// block. New PR fields go into PR_FRAGMENT here — never a new query;
// rate limits and latency are real.
//
// "One batch" is about not fetching PER ROW. It is NOT "one HTTP
// request": the batch is split into a few fixed-size chunks below, for
// a ceiling that has nothing to do with rate limits. See CHUNK_SIZE.

// Comment window. 10 covers the details-pane conversation; checklist
// review-bot mode ALSO finds the bot's summary comment in this window,
// so it widens — a summary buried past the window would silently read
// as "the bot never ran".
const COMMENT_FETCH_LIMIT = config.reviewBot.unresolvedVia === "checklist" ? 30 : 10;

/**
 * Branches per GraphQL round trip.
 *
 * GitHub gives a GraphQL query roughly ten seconds of server-side
 * execution, and this query's cost is linear in branch count at about
 * 250ms per branch. Measured against a real repo: 24 branches took
 * 6.9-7.7s in a single request, so a fleet at 35 sat on the ceiling.
 * That is a LATENCY CLIFF, not a quota, and the distinction is the
 * whole reason this constant exists — on the day it was diagnosed, 126
 * of 130 failures were at exactly `branchCount: 35`, every one of them
 * a 502/504, GitHub's own "couldn't respond to your request in time",
 * an HTTP/2 stream CANCEL or a truncated body, while 2184 of 5000
 * GraphQL points sat unspent. Nothing was rate limited.
 *
 * Note which fixes that rules out. Throttling our side is the natural
 * reflex and is exactly backwards: fewer, larger, less frequent
 * requests is the direction that fails. Trimming fields does not rescue
 * it either, because no single field dominates — dropping the most
 * expensive one takes 7.5s to 6.1s, and stripping everything but
 * scalars still leaves 2.2s.
 *
 * Splitting is close to free on the budget that actually IS metered:
 * GraphQL points are computed from node count, so the same 24 branches
 * cost 27 points as one request and 27-28 spread across three or four.
 * Wall clock improves at the same time, because the chunks run
 * concurrently: 7.7s at one request, 3.2s at chunk 8, 2.4s at chunk 6.
 *
 * 8 keeps a chunk near 3s — a third of the budget — so the cliff stays
 * far away as the fleet grows. Concurrency is deliberately left to
 * `run`'s own RUN_CONCURRENCY rather than a private cap here: that is a
 * render-thread spawn budget, which is precisely the resource a wide
 * fan-out would otherwise take from the rest of the TUI.
 */
export const CHUNK_SIZE = 8;

/** Subprocess budget for ONE attempt. ~5x the measured chunk latency. */
const ATTEMPT_TIMEOUT_MS = 15_000;

/** Attempts per chunk: one try plus two retries. */
const MAX_ATTEMPTS = 3;

/** Backoff base; each retry doubles it and adds full jitter. */
const RETRY_BASE_MS = 400;

/**
 * Ceiling across every attempt of every chunk. Bounds the pathological
 * case (all chunks timing out and retrying) well inside the caller's
 * poll interval, so a wedged fetch can't still be running when the next
 * one starts.
 */
const RETRY_DEADLINE_MS = 40_000;

/**
 * Failures a retry can actually fix. A 502/504, GitHub's own "couldn't
 * respond in time", an HTTP/2 CANCEL and a truncated body are the same
 * event seen from four different layers: the query ran out of
 * server-side time.
 */
const TRANSIENT_PATTERNS = [
  /\bHTTP 5\d\d\b/,
  /couldn't respond to your request in time/i,
  /no server is currently available/i,
  /stream error:.*\bCANCEL\b/i,
  /unexpected end of JSON input/i,
  /\b(connection reset|broken pipe|i\/o timeout|unexpected EOF)\b/i,
];

/**
 * Never retried, and the rate-limit entries are the load-bearing half:
 * retrying a rate limit is what turns a brush with the limit into a
 * block. Auth failures, malformed queries and 404s are simply permanent
 * — a retry spends a round trip to be told the same thing.
 */
const PERMANENT_PATTERNS = [
  /rate limit/i,
  /RATE_LIMITED/,
  /secondary rate/i,
  /abuse detection/i,
  /Bad credentials/i,
  /authentication/i,
  /Could not resolve to a Repository/i,
];

export function isTransientFailure(r: RunResult): boolean {
  const body = `${r.stderr}\n${r.stdout}`;
  if (PERMANENT_PATTERNS.some((re) => re.test(body))) return false;
  // `run` surfaces its own SIGKILL timeout as a negative exit code with
  // nothing captured. That attempt outlived ATTEMPT_TIMEOUT_MS, which is
  // the same story the 504s tell, just told by our side of the wire.
  if (r.exitCode < 0) return true;
  return TRANSIENT_PATTERNS.some((re) => re.test(body));
}

/** Sleep that gives up early when the fetch is superseded. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let unchain = (): void => {};
    const timer = setTimeout(() => {
      unchain();
      resolve();
    }, ms);
    if (signal) {
      unchain = chainSignal(signal, () => {
        clearTimeout(timer);
        resolve();
      });
    }
  });
}

export function chunkBranches(branches: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < branches.length; i += size) out.push(branches.slice(i, i + size));
  return out;
}

// Shared fields for each PR. Used by every aliased sub-query below.
const PR_FRAGMENT = `
fragment PrFields on PullRequest {
  id
  number
  url
  title
  headRefName
  headRefOid
  baseRefName
  isDraft
  state
  mergeable
  mergeStateStatus
  mergedAt
  closedAt
  reviewDecision
  reviewRequests(first: 20) {
    totalCount
    nodes {
      requestedReviewer {
        __typename
        ... on User { login }
        ... on Team { combinedSlug }
      }
    }
  }
  suggestedReviewers {
    reviewer { login }
    isAuthor
    isCommenter
  }
  autoMergeRequest {
    enabledAt
    mergeMethod
  }
  commits(last: 1) {
    nodes {
      commit {
        committedDate
        statusCheckRollup {
          contexts(first: 50) {
            nodes {
              __typename
              ... on CheckRun { name status conclusion }
              ... on StatusContext { context state }
            }
          }
        }
      }
    }
  }
  reviewThreads(first: 50) {
    nodes {
      isResolved
      comments(first: 1) {
        nodes { author { login __typename } }
      }
    }
  }
  comments(last: ${COMMENT_FETCH_LIMIT}) {
    nodes {
      author { login __typename }
      body
      createdAt
      updatedAt
    }
  }
  reviews(last: 10) {
    nodes {
      author { login __typename }
      body
      state
      createdAt
    }
  }
}`;

/**
 * Build a graphql doc with one aliased `pullRequests(headRefName:)`
 * sub-query per branch in THIS chunk. `first: 2` per branch catches the
 * rare "branch has a reopen" case where there's an OPEN and a terminal
 * PR on the same ref — we'll prefer OPEN at parse time.
 *
 * Scoping to exact branches rather than pulling the 100 most recent
 * drops wall-clock ~4x and response size ~8x at 10 worktrees; it also
 * means the query cost is bounded by the number of worktrees, not by
 * how busy the repo is.
 *
 * The merge queue is repo-wide, so it rides exactly one chunk rather
 * than being refetched by each.
 */
export function buildQuery(branchCount: number, withMergeQueue: boolean): string {
  const varDecls = Array.from({ length: branchCount }, (_, i) => `$b${i}: String!`).join(", ");
  const aliases = Array.from({ length: branchCount }, (_, i) =>
    `    wt_${i}: pullRequests(first: 2, headRefName: $b${i}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...PrFields } }`,
  ).join("\n");
  const mergeQueue = withMergeQueue
    ? `
    mergeQueue {
      entries(first: 50) {
        nodes {
          enqueuedAt
          estimatedTimeToMerge
          position
          state
          pullRequest { headRefName }
        }
      }
    }`
    : "";
  return `
query($owner: String!, $name: String!, ${varDecls}) {
  repository(owner: $owner, name: $name) {
${aliases}${mergeQueue}
  }
}
${PR_FRAGMENT}`;
}

/**
 * One chunk's round trip, retried on transient failure. Retries live
 * here rather than at the TanStack observer for two reasons: a retry
 * re-runs only the chunk that failed instead of the whole fan-out, and
 * the CLI callers plus the webhook daemon (which never touch the query
 * client) get the same resilience.
 *
 * The TUI's global `retry: false` is deliberate and still right for
 * anything a keystroke drives — but this fetch is a background poll
 * with no user watching, and `keepPreviousData` holds the last good
 * badges on screen throughout, so a retry here is invisible rather than
 * "annoying in a TUI".
 */
async function fetchChunk(
  owner: string,
  name: string,
  branches: string[],
  withMergeQueue: boolean,
  deadline: number,
  signal: AbortSignal | undefined,
): Promise<GithubData> {
  const query = buildQuery(branches.length, withMergeQueue);
  const args = [
    "gh",
    "api",
    "graphql",
    "-f",
    `query=${query}`,
    "-f",
    `owner=${owner}`,
    "-f",
    `name=${name}`,
  ];
  for (let i = 0; i < branches.length; i++) {
    args.push("-f", `b${i}=${branches[i]}`);
  }

  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const r = await run(args, {
      cwd: config.paths.mainClone,
      timeoutMs: ATTEMPT_TIMEOUT_MS,
      signal,
    });

    // Cancelled mid-flight (branch list re-keyed, `run` SIGTERMed the
    // child). Routine supersession, not a failure — unwind quietly and
    // let the caller return empty.
    if (signal?.aborted) return { prs: new Map(), mergeQueue: new Map() };

    if (r.exitCode === 0) {
      const parsed = parseChunk(r, branches, withMergeQueue);
      if (parsed) return parsed;
      // Exit 0 with an unusable body. `unexpected end of JSON input` is
      // a truncated response, which is the timeout wearing yet another
      // costume, so it goes through the same transient test.
      lastError = firstLine(r.stdout) || "unparseable gh output";
      if (!isTransientFailure(r)) break;
    } else {
      lastError = firstLine(r.stderr) || firstLine(r.stdout) || `gh exited ${r.exitCode}`;
      if (!isTransientFailure(r)) {
        log.error("gh api graphql failed (permanent)", {
          exitCode: r.exitCode,
          stderr: r.stderr.slice(0, 400),
          stdout: r.stdout.slice(0, 400),
          branchCount: branches.length,
        });
        break;
      }
    }

    if (attempt === MAX_ATTEMPTS) break;
    // Full jitter: two chunks that fail together must not retry in
    // lockstep, or they reproduce the burst that timed them out.
    const backoff = Math.round(Math.random() * RETRY_BASE_MS * 2 ** (attempt - 1));
    if (Date.now() + backoff >= deadline) {
      log.warn("gh api graphql: retry budget exhausted", {
        attempt,
        branchCount: branches.length,
        error: lastError.slice(0, 200),
      });
      break;
    }
    log.warn("gh api graphql: transient failure, retrying", {
      attempt,
      backoffMs: backoff,
      branchCount: branches.length,
      error: lastError.slice(0, 200),
    });
    await delay(backoff, signal);
    if (signal?.aborted) return { prs: new Map(), mergeQueue: new Map() };
  }

  // A genuine failure must THROW, not return empty: an empty success
  // overwrites the last good PR data with "no PRs anywhere" on the first
  // transient blip, while a rejection keeps the cached data and surfaces
  // through the details pane's error row.
  throw new Error(`github fetch failed: ${lastError}`);
}

/**
 * Parse one chunk's response. Returns null when the body is
 * structurally unusable, which the caller treats as a retryable
 * failure rather than as data.
 */
function parseChunk(
  r: RunResult,
  branches: string[],
  withMergeQueue: boolean,
): GithubData | null {
  let parsed: GqlResponse;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return null;
  }
  // Exit 0 with no repository payload = a GraphQL-level error response
  // (partial errors land in an `errors` array we don't model).
  const repo = parsed.data?.repository;
  if (!repo) return null;

  const prs = new Map<string, PullRequest>();
  for (let i = 0; i < branches.length; i++) {
    const nodes = repo[`wt_${i}`]?.nodes ?? [];
    if (nodes.length === 0) continue;
    // Prefer OPEN when a branch has multiple PRs (reopens etc.). Sort
    // is stable, so among non-OPEN we keep UPDATED_AT-desc order.
    const sorted = [...nodes].sort(
      (a, b) => (a.state === "OPEN" ? 0 : 1) - (b.state === "OPEN" ? 0 : 1),
    );
    const chosen = sorted[0];
    if (!chosen || !chosen.headRefName) continue;
    prs.set(chosen.headRefName, nodeToPr(chosen));
  }

  const mergeQueue = new Map<string, MergeQueueEntry>();
  if (withMergeQueue) {
    for (const n of repo.mergeQueue?.entries?.nodes ?? []) {
      const head = n.pullRequest?.headRefName;
      if (!head) continue;
      mergeQueue.set(head, {
        headRefName: head,
        position: n.position,
        state: n.state,
        enqueuedAt: n.enqueuedAt,
        estimatedTimeToMerge: n.estimatedTimeToMerge,
      });
    }
  }

  return { prs, mergeQueue };
}

/**
 * Fetch PRs for a fixed set of branches + merge-queue entries, as a
 * small fixed number of concurrent graphql round trips (see
 * CHUNK_SIZE). Pass the exact worktree branches; anything not on the
 * list is never fetched (the TUI wouldn't display it anyway).
 *
 * `signal` (when provided) cascades into every underlying `gh`
 * invocation so a superseded query — branch list re-keyed before the
 * previous fetch returned — actually stops the subprocesses instead of
 * letting them burn graphql round trips on data nobody will read.
 */
export async function fetchGithub(
  branches: string[],
  signal?: AbortSignal,
): Promise<GithubData> {
  const empty: GithubData = { prs: new Map(), mergeQueue: new Map() };
  if (!(await hasGh())) return empty;
  const slug = await repoSlug();
  if (!slug) return empty;
  const [owner, name] = slug.split("/");
  if (!owner || !name) return empty;
  // No worktrees → nothing to show a merge-queue position for either,
  // so there is nothing worth a round trip.
  if (branches.length === 0) return empty;

  const groups = chunkBranches(branches, CHUNK_SIZE);
  const deadline = Date.now() + RETRY_DEADLINE_MS;
  const settled = await Promise.allSettled(
    groups.map((g, i) => fetchChunk(owner, name, g, i === 0, deadline, signal)),
  );

  if (signal?.aborted) return empty;

  const failed = settled.filter((s) => s.status === "rejected");
  if (failed.length > 0) {
    // Partial data is worse than none. A chunk that fails while its
    // siblings succeed would blank the PR badge on exactly its branches,
    // which is indistinguishable from "those branches have no PR" —
    // a silent, per-row version of the same lie an empty success tells.
    // Failing the whole fetch keeps the last good cache for every row.
    const reason = (failed[0] as PromiseRejectedResult).reason;
    log.error("gh api graphql failed", {
      failedChunks: failed.length,
      totalChunks: groups.length,
      branchCount: branches.length,
      error: reason instanceof Error ? reason.message : String(reason),
    });
    throw reason instanceof Error ? reason : new Error(String(reason));
  }

  const prs = new Map<string, PullRequest>();
  const mergeQueue = new Map<string, MergeQueueEntry>();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const [k, v] of s.value.prs) prs.set(k, v);
    for (const [k, v] of s.value.mergeQueue) mergeQueue.set(k, v);
  }
  return { prs, mergeQueue };
}

/**
 * Thin wrapper kept for CLI callers (doctor, ls) that don't have a
 * prebuilt branch list. Resolves branches from `git worktree list`
 * before fetching. Degrades to an empty map on fetch failure — a CLI
 * listing without PR columns beats a crashed listing — but says so on
 * stderr instead of impersonating "no PRs".
 */
export async function fetchPrs(): Promise<Map<string, PullRequest>> {
  const branches = (await listWorktrees())
    .filter((w) => !w.isMain && w.branch)
    .map((w) => w.branch as string);
  try {
    return (await fetchGithub(branches)).prs;
  } catch (err) {
    console.error(`wt: ${err instanceof Error ? err.message : String(err)} (PR info omitted)`);
    return new Map();
  }
}
