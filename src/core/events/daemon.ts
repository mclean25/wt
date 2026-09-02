/**
 * The `wt events` webhook daemon: a long-lived loopback HTTP server that
 * turns GitHub webhook deliveries into github-query refreshes.
 *
 * It is a *signal*, not a data source. A delivery never reconstructs
 * `GithubData` from the (differently-shaped) webhook payload; it just
 * tells the daemon something changed on one of our worktree branches, and
 * the daemon re-runs the same batched `fetchGithub` the TUI uses, writes a
 * snapshot, and rewrites the marker. The TUI picks up the marker and reads
 * the warm snapshot. One bounded GraphQL round-trip per burst, debounced.
 *
 * Auth is the webhook HMAC secret (`X-Hub-Signature-256`) and nothing
 * else: a plain repo webhook, no GitHub App, no installation token. Data
 * still flows through the user's existing `gh` auth.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Clock, Data, Duration, Effect, Exit, Queue, Ref, Scope, Semaphore } from "effect";

import { buildSha, currentSourceSha } from "../build-id.ts";
import { config, type GithubEventsConfig } from "../config.ts";
import { fetchGithub, type GithubData } from "../github.ts";
import { createLogger, flushLogger } from "../logger.ts";
import { fetchOrigin, listWorktrees } from "../worktree.ts";

import {
  ensureEventsDir,
  touchMarker,
  writeSnapshot,
  writeState,
  type EventsState,
} from "./store.ts";

const log = createLogger("[events]");

/** Coalesce check_run/check_suite bursts into one fetch per CI step storm. */
const FETCH_DEBOUNCE_MS = 1_500;
/**
 * Floor on the sustained refetch rate. The debounce alone only collapses
 * deliveries that arrive *together*; under a stream it schedules a fetch
 * as fast as fetches complete, so the cadence ends up set by query latency
 * rather than by any policy. Measured on an 18-branch fleet with a merge
 * queue running: 130 deliveries in 180s produced 13 full refetches at ~30
 * GraphQL points each, a 7,760 points/hour pace against a 5,000/hour limit
 * — and a rate-limited fetch is the one failure `fetchGithub` deliberately
 * never retries.
 *
 * Costs nothing visible because it is a third of `SNAPSHOT_FRESH_MS`: the
 * TUI serves a snapshot up to 90s old, so a fetch deferred to 30s is still
 * well inside the window the renderer already treats as current. And it
 * only ever delays the *Nth* fetch of a burst — the first delivery after a
 * quiet spell still lands in `FETCH_DEBOUNCE_MS`, which is the case that
 * governs how fast a badge flips after you push.
 */
const MIN_FETCH_INTERVAL_MS = 30_000;
/**
 * Reject webhook bodies larger than this before buffering them. GitHub
 * payloads are well under this (typically <1MB, hard-capped ~25MB), so the
 * cap only bites a malformed or hostile request — which matters once the
 * listener binds beyond loopback (a non-`127.0.0.1` `host`).
 */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Re-read the worktree branch set at most this often when deciding relevance. */
const LOCAL_BRANCHES_TTL_MS = 30_000;

/** Webhook event types worth a refresh. Everything else is dropped. */
const RELEVANT_EVENTS = new Set([
  "pull_request",
  "pull_request_review",
  // Thread resolve/unresolve drives the threads-mode review-bot
  // "unresolved" badge and doesn't fire pull_request_review.
  "pull_request_review_thread",
  // PR comments feed the details-pane conversation, and in checklist
  // mode the review bot's summary comment (and its checkbox ticks,
  // which arrive as `edited`) IS the unresolved signal.
  "issue_comment",
  "check_suite",
  "check_run",
  "status",
  "merge_group",
  "push",
]);

/**
 * Resolve the HMAC secret: inline wins, else the secret file's trimmed
 * contents, else null (daemon refuses to start — unsigned webhooks are not
 * accepted).
 */
export function resolveWebhookSecret(events: GithubEventsConfig): string | null {
  if (events.secret) return events.secret;
  if (events.secretFile) {
    try {
      const s = readFileSync(events.secretFile, "utf8").trim();
      return s.length > 0 ? s : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Constant-time verify of GitHub's `sha256=<hex>` body signature. */
function verifySignature(body: string, header: string | null, secret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const mac = createHmac("sha256", secret).update(body).digest("hex");
  const expected = `sha256=${mac}`;
  // timingSafeEqual throws on length mismatch; guard first. Both sides are
  // attacker-influenced only via `header`, and the length of a valid hex
  // digest is fixed, so an early length check leaks nothing useful.
  if (expected.length !== header.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}

/**
 * Candidate head branches an event concerns, or null when the event is
 * intentionally unscoped. Null means "don't try to skip — just refetch", so
 * the local-branch gate never drops it; a payload-shape change (or a
 * cross-cutting event) degrades to more fetches, never to missed updates.
 */
export function extractBranches(event: string, payload: unknown): string[] | null {
  const p = payload as Record<string, any> | null;
  if (!p) return null;
  try {
    switch (event) {
      // PR-surface events drive TWO things: the per-worktree github query
      // (when the PR is on a branch you have checked out) AND the
      // cross-cutting "review requests" list — PRs awaiting *your* review,
      // which by definition live on other people's branches, never local
      // worktrees. Branch-skipping them would silently drop every
      // review-requests update (e.g. an approval you submit never clears the
      // item until a manual `r`). So never skip them: the marker is what
      // re-pulls the review-requests list, and the worktree snapshot refetch
      // is bounded and serves its warm cache when nothing local changed.
      case "pull_request":
      case "pull_request_review":
      case "pull_request_review_thread":
        return null;
      case "check_suite": {
        const ref = p.check_suite?.head_branch;
        return typeof ref === "string" ? [ref] : null;
      }
      case "check_run": {
        const ref = p.check_run?.check_suite?.head_branch;
        return typeof ref === "string" ? [ref] : null;
      }
      // A status is keyed to a commit SHA; its `branches` array is an
      // unreliable scoping signal (often lists only the default branch, or
      // is empty for feature-branch CI), so a non-empty-but-non-matching
      // list would wrongly SKIP a real CI update — the one non-fail-safe
      // direction. Treat like merge_group: never skip, always refetch.
      case "status":
        return null;
      // An issue_comment on a PR carries only the PR number, never the
      // head branch — unscopeable, always refetch. Comments on plain
      // (non-PR) issues are identifiable (`issue.pull_request` is absent)
      // and can never affect PR state — return an empty candidate list so
      // the local-branch gate skips them.
      case "issue_comment":
        return p.issue?.pull_request ? null : [];
      // merge_group head_ref is a synthetic `gh-readonly-queue/...` ref, not
      // a worktree branch — never skippable, always refetch for the queue.
      case "merge_group":
        return null;
      case "push": {
        const ref = p.ref;
        if (typeof ref !== "string") return null;
        const prefix = "refs/heads/";
        if (!ref.startsWith(prefix)) return null;
        const branch = ref.slice(prefix.length);
        return branch === config.branch.base ? null : [branch];
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * When a queued refetch may fire, given the last fetch's *start* time and
 * the firing time of any already-pending timer.
 *
 * Returns null to mean "a pending timer already satisfies both constraints
 * — leave it alone". That branch is load-bearing, and specifically because
 * of the fix it ships with. Re-arming on every delivery starves the fetch:
 * deliveries closer together than `FETCH_DEBOUNCE_MS` push the firing time
 * out again each time, indefinitely. That hazard was always latent in the
 * debounce, but it never fired, because the trailing re-run bypassed the
 * scheduler and ran immediately — the unbounded path masked the starvable
 * one. Routing the trailing re-run through here is what arms it. Simulated
 * against this fleet's measured rate (~43 deliveries/min, one per 1.4s
 * against a 1.5s debounce): the naive rule defers past 151s and climbing
 * for as long as the stream lasts. So only the first delivery after a
 * fetch arms the timer; every later one in the window is a no-op.
 *
 * Measured from the fetch's start, not its finish, so the floor caps the
 * rate rather than adding to a slow query's latency.
 */
export function nextFetchAt(
  now: number,
  lastFetchStartedAt: number,
  pendingAt: number | null,
): number | null {
  const earliest = Math.max(
    now + FETCH_DEBOUNCE_MS,
    lastFetchStartedAt + MIN_FETCH_INTERVAL_MS,
  );
  if (pendingAt !== null && pendingAt <= earliest) return null;
  return earliest;
}

export class DaemonOperationError extends Data.TaggedError("DaemonOperationError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type GithubResult = GithubData;
type Delivery = {
  readonly event: string;
  readonly branches: readonly string[] | null;
  readonly receivedAt: number;
};

export type DaemonDependencies = {
  readonly ensureEventsDir: () => void;
  readonly currentBranches: () => Effect.Effect<readonly string[], DaemonOperationError>;
  readonly fetchOrigin: Effect.Effect<void, DaemonOperationError>;
  readonly fetchGithub: (branches: readonly string[]) => Effect.Effect<GithubResult, DaemonOperationError>;
  readonly writeSnapshot: typeof writeSnapshot;
  readonly touchMarker: typeof touchMarker;
  readonly writeState: typeof writeState;
  readonly sourceMoved: () => boolean;
  readonly exitForUpgrade: Effect.Effect<never>;
};

export type DaemonCore = {
  readonly accept: (event: string, body: string) => Effect.Effect<void, DaemonOperationError>;
  readonly state: Effect.Effect<EventsState>;
};

type Daemon = { readonly stop: () => Promise<void> };

function errorMessage(error: unknown): string {
  if (error instanceof DaemonOperationError) return errorMessage(error.cause);
  return error instanceof Error ? error.message : String(error);
}

const trySync = <A>(operation: string, evaluate: () => A) => Effect.try({
  try: evaluate,
  catch: (cause) => new DaemonOperationError({ operation, cause }),
});

function productionDependencies(): DaemonDependencies {
  return {
    ensureEventsDir,
    currentBranches: () => listWorktrees().pipe(
      Effect.map((wts) => wts.filter((w) => !w.isMain && w.branch).map((w) => w.branch as string)),
      Effect.mapError((cause) => new DaemonOperationError({ operation: "list worktrees", cause })),
    ),
    fetchOrigin: fetchOrigin().pipe(
      Effect.mapError((cause) => new DaemonOperationError({ operation: "fetch origin", cause })),
    ),
    // The native Effect, not its Promise twin: a scope close must reach the
    // in-flight `gh` subprocess, and a `runPromise` island would hide it.
    fetchGithub: (branches) => fetchGithub([...branches]).pipe(
      Effect.mapError((cause) => new DaemonOperationError({ operation: "fetch GitHub", cause })),
    ),
    writeSnapshot,
    touchMarker,
    writeState,
    sourceMoved: () => {
      const started = buildSha();
      if (started === null) return false;
      const now = currentSourceSha();
      return now !== null && now !== started;
    },
    exitForUpgrade: Effect.sync((): void => { process.exit(0); }).pipe(Effect.andThen(Effect.never)),
  };
}

/** Scoped engine: all timers and workers are child fibers joined on close. */
export const makeDaemonCore = (
  events: GithubEventsConfig,
  dependencies: DaemonDependencies,
): Effect.Effect<DaemonCore, DaemonOperationError, Scope.Scope> => Effect.gen(function* () {
  const initialState: EventsState = {
    pid: process.pid,
    port: events.port,
    startedAt: yield* Clock.currentTimeMillis,
    lastEventAt: null,
    lastFetchAt: null,
    eventCount: 0,
    lastError: null,
  };
  yield* trySync("create events directory", dependencies.ensureEventsDir);
  yield* trySync("write daemon state", () => dependencies.writeState(initialState));

  const state = yield* Ref.make(initialState);
  const stateLock = yield* Semaphore.make(1);
  const updateState = (update: (current: EventsState) => EventsState) => stateLock.withPermits(1)(
    Effect.gen(function* () {
      const next = yield* Ref.modify(state, (current) => {
        const updated = update(current);
        return [updated, updated] as const;
      });
      yield* trySync("write daemon state", () => dependencies.writeState(next));
      return next;
    }),
  );

  const localBranches = yield* Ref.make<{ readonly branches: ReadonlySet<string>; readonly at: number }>({
    branches: new Set(), at: 0,
  });
  const lastFetchStartedAt = yield* Ref.make(0);
  const deliveries = yield* Queue.dropping<Delivery>(64);
  const scheduleSignals = yield* Queue.dropping<void>(1);
  const fetchRequests = yield* Queue.dropping<void>(1);

  const getLocalBranches = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const cached = yield* Ref.get(localBranches);
    if (cached.branches.size > 0 && now - cached.at < LOCAL_BRANCHES_TTL_MS) return cached.branches;
    const branches = yield* dependencies.currentBranches();
    const next = { branches: new Set(branches), at: now };
    yield* Ref.set(localBranches, next);
    return next.branches;
  });

  const processDelivery = ({ event, branches, receivedAt }: Delivery) => Effect.gen(function* () {
    if (branches) {
      const relevant = yield* getLocalBranches.pipe(
        Effect.map((local) => branches.some((branch) => local.has(branch))),
        Effect.catch((error) => {
          log.warn("local-branch check failed; refetching anyway", { err: errorMessage(error) });
          return Effect.succeed(true);
        }),
      );
      if (!relevant) {
        log.debug("ignored event for non-local branch", { event, branches });
        return;
      }
    }
    yield* updateState((current) => ({
      ...current,
      eventCount: current.eventCount + 1,
      lastEventAt: receivedAt,
    }));
    yield* Queue.offer(scheduleSignals, undefined);
  });

  const scheduler = (pendingAt: number | null): Effect.Effect<never> => Effect.gen(function* () {
    if (pendingAt === null) {
      yield* Queue.take(scheduleSignals);
      const now = yield* Clock.currentTimeMillis;
      const lastStarted = yield* Ref.get(lastFetchStartedAt);
      return yield* scheduler(nextFetchAt(now, lastStarted, null) ?? now);
    }
    const now = yield* Clock.currentTimeMillis;
    const next = yield* Effect.race(
      Queue.take(scheduleSignals).pipe(Effect.as("signal" as const)),
      Effect.sleep(Duration.millis(Math.max(0, pendingAt - now))).pipe(Effect.as("fire" as const)),
    );
    if (next === "fire") {
      yield* Queue.offer(fetchRequests, undefined);
      return yield* scheduler(null);
    }
    const signalAt = yield* Clock.currentTimeMillis;
    const lastStarted = yield* Ref.get(lastFetchStartedAt);
    return yield* scheduler(nextFetchAt(signalAt, lastStarted, pendingAt) ?? pendingAt);
  });

  const runFetch = Effect.gen(function* () {
    if (dependencies.sourceMoved()) {
      log.info("wt source moved under a running daemon — exiting so launchd restarts it", {
        startedFrom: buildSha(), now: currentSourceSha(),
      });
      const current = yield* Ref.get(state);
      yield* trySync("write daemon state", () => dependencies.writeState(current));
      yield* flushLogger;
      return yield* dependencies.exitForUpgrade;
    }
    const startedAt = yield* Clock.currentTimeMillis;
    const previousStartedAt = yield* Ref.getAndSet(lastFetchStartedAt, startedAt);
    const sinceLast = previousStartedAt === 0 ? null : startedAt - previousStartedAt;
    yield* dependencies.fetchOrigin.pipe(Effect.catch((error) => Effect.sync(() => {
      log.warn("origin refresh after webhook failed", { err: errorMessage(error) });
    })));
    const branches = yield* dependencies.currentBranches();
    yield* Ref.set(localBranches, { branches: new Set(branches), at: yield* Clock.currentTimeMillis });
    const { prs, mergeQueue } = yield* dependencies.fetchGithub(branches);
    const committedAt = yield* Clock.currentTimeMillis;
    yield* Effect.uninterruptible(Effect.gen(function* () {
      yield* trySync("write GitHub snapshot", () => dependencies.writeSnapshot({
        updatedAt: committedAt,
        branches: [...branches],
        prs: Object.fromEntries(prs),
        mergeQueue: Object.fromEntries(mergeQueue),
        writerSha: buildSha(),
      }));
      yield* trySync("touch GitHub marker", () => dependencies.touchMarker(committedAt));
      yield* updateState((current) => ({ ...current, lastFetchAt: committedAt, lastError: null }));
    }));
    log.info("refetched after webhook", { branches: branches.length, prs: prs.size, sinceLastMs: sinceLast });
  }).pipe(Effect.catch((error) => Effect.gen(function* () {
    const message = errorMessage(error);
    yield* updateState((current) => ({ ...current, lastError: message })).pipe(Effect.catch(() => Effect.void));
    log.error("webhook refetch failed", { err: message });
  })));

  yield* Effect.forkScoped(Effect.forever(Queue.take(deliveries).pipe(Effect.flatMap(processDelivery))));
  yield* Effect.forkScoped(scheduler(null));
  yield* Effect.forkScoped(Effect.forever(Queue.take(fetchRequests).pipe(Effect.andThen(runFetch))));
  yield* Queue.offer(fetchRequests, undefined);

  return {
    accept: (event, body) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const payload = yield* trySync("parse webhook body", () => JSON.parse(body)).pipe(
        Effect.catch(() => {
          log.warn("webhook body not JSON", { event });
          return Effect.succeed(null);
        }),
      );
      if (payload === null) return;
      const accepted = yield* Queue.offer(deliveries, {
        event,
        branches: extractBranches(event, payload),
        receivedAt: now,
      });
      // The body has already been reduced to a tiny summary. If even the
      // bounded summary queue is saturated, conservatively coalesce the
      // dropped delivery into one fetch signal instead of retaining input.
      if (!accepted) yield* Queue.offer(scheduleSignals, undefined);
    }),
    state: Ref.get(state),
  };
});

const acquireServer = (
  events: GithubEventsConfig,
  secret: string,
  core: DaemonCore,
): Effect.Effect<{ stop(force?: boolean): void }, DaemonOperationError, Scope.Scope> => Effect.gen(function* () {
  const context = yield* Effect.context<never>();
  return yield* Effect.acquireRelease(
    trySync("start webhook server", () => Bun.serve({
      port: events.port,
      hostname: events.host,
      maxRequestBodySize: MAX_BODY_BYTES,
      async fetch(req): Promise<Response> {
        const url = new URL(req.url);
        if (req.method === "GET" && url.pathname === "/health") {
          const current = await Effect.runPromiseWith(context)(core.state);
          return Response.json({ ok: true, port: events.port, eventCount: current.eventCount });
        }
        if (req.method !== "POST" || url.pathname !== "/webhook") return new Response("not found", { status: 404 });
        const len = Number(req.headers.get("content-length") ?? 0);
        if (Number.isFinite(len) && len > MAX_BODY_BYTES) return new Response("payload too large", { status: 413 });
        const body = await req.text();
        if (!verifySignature(body, req.headers.get("x-hub-signature-256"), secret)) {
          log.warn("webhook signature rejected", { delivery: req.headers.get("x-github-delivery") });
          return new Response("invalid signature", { status: 401 });
        }
        const event = req.headers.get("x-github-event") ?? "";
        if (event === "ping") return Response.json({ ok: true });
        if (RELEVANT_EVENTS.has(event)) {
          try {
            await Effect.runPromiseWith(context)(core.accept(event, body));
          } catch (error) {
            log.error("failed to persist webhook delivery", { err: errorMessage(error) });
            return new Response("failed to accept delivery", { status: 503 });
          }
        }
        return Response.json({ ok: true });
      },
    })),
    (server) => Effect.promise(() => server.stop(true)),
  );
});

/** Start the server + fetch loop. Returns a stop handle; does not block. */
export function startDaemon(events: GithubEventsConfig, secret: string): Daemon {
  const scope = Effect.runSync(Scope.make());
  try {
    Effect.runSync(Effect.gen(function* () {
      const core = yield* makeDaemonCore(events, productionDependencies());
      yield* acquireServer(events, secret, core);
    }).pipe(Scope.provide(scope)));
  } catch (error) {
    Effect.runSync(Scope.close(scope, Exit.void));
    throw error;
  }
  log.info("events daemon listening", { host: events.host, port: events.port });
  let stopping: Promise<void> | null = null;
  return { stop: () => stopping ??= Effect.runPromise(Scope.close(scope, Exit.void)) };
}

/**
 * Foreground entry point for `wt events serve` (and the launchd agent).
 * Resolves the secret, starts the daemon, and parks the process until a
 * termination signal. Returns the intended process exit code.
 */
export async function runDaemonForeground(): Promise<number> {
  const events = config.github.events;
  if (!events) {
    process.stderr.write(
      "wt events: [github.events] is not configured in config.toml\n",
    );
    return 1;
  }
  const secret = resolveWebhookSecret(events);
  if (!secret) {
    // Distinguish "nothing configured" from "secret_file is set but
    // unreadable/empty" — the latter shouldn't send the user to mint a new
    // secret when they already have one.
    const hint = events.secretFile
      ? `couldn't read a secret from ${events.secretFile} — check it exists and is readable, or run \`wt events secret\``
      : "set [github.events].secret or secret_file (run `wt events secret` to generate one)";
    process.stderr.write(`wt events: no webhook secret. ${hint}.\n`);
    return 1;
  }
  let daemon: ReturnType<typeof startDaemon>;
  try {
    daemon = startDaemon(events, secret);
  } catch (err) {
    // The most likely failure is the loopback port already in use (a stale
    // or double-started daemon). Report it cleanly instead of letting the
    // raw Bun.serve throw print a stack trace into the launchd error log.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `wt events: failed to start on port ${events.port}: ${msg}\n` +
        "(is another daemon already running? check `wt events status`)\n",
    );
    return 1;
  }
  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });
  await daemon.stop();
  return 0;
}
