/**
 * Repo-state probes and the pure offer/gate decisions for the
 * self-update system. Config-free (see exec.ts).
 */
import { Effect } from "effect";
import {
  gitOk,
  logSafe,
  runIn,
  WT_REPO_ROOT,
} from "./exec.ts";
import type { UpdateMemory } from "./memory.ts";

export type RepoUpdateState = {
  /** Uncommitted changes in the source clone. */
  dirty: boolean;
  /** Upstream ref name, or null when HEAD has none (detached, local branch). */
  upstream: string | null;
  /** Local commits not on upstream. */
  ahead: number;
  /** Upstream commits not local (as of the last fetch). */
  behind: number;
  /** Full shas; display via shortSha. */
  headSha: string;
  remoteSha: string;
};

/** Null when the source tree isn't a git checkout (or git is missing). */
export const repoUpdateState: Effect.Effect<RepoUpdateState | null> =
  Effect.gen(function* () {
    const headSha = yield* gitOk(["rev-parse", "HEAD"]);
    if (headSha === null) return null;
    const status = yield* gitOk(["status", "--porcelain"]);
    const dirty = status !== null && status.length > 0;
    const upstream = yield* gitOk([
      "rev-parse",
      "--abbrev-ref",
      "@{u}",
    ]);
    if (upstream === null) {
      return {
        dirty,
        upstream: null,
        ahead: 0,
        behind: 0,
        headSha,
        remoteSha: "",
      };
    }
    const counts =
      (yield* gitOk([
        "rev-list",
        "--left-right",
        "--count",
        "@{u}...HEAD",
      ])) ?? "0 0";
    const [behindRaw, aheadRaw] = counts.split(/\s+/);
    const remoteSha = (yield* gitOk(["rev-parse", "@{u}"])) ?? "";
    return {
      dirty,
      upstream,
      ahead: parseInt(aheadRaw ?? "0", 10) || 0,
      behind: parseInt(behindRaw ?? "0", 10) || 0,
      headSha,
      remoteSha,
    };
  });

/** One bounded fetch of the clone's default remote. False on failure (offline, auth). */
export const fetchWtOrigin: Effect.Effect<boolean> = runIn(
  ["git", "fetch", "--quiet"],
  { cwd: WT_REPO_ROOT, timeoutMs: 20_000 },
).pipe(
  Effect.match({
    onFailure: (error) => {
      logSafe("warn", `git fetch failed: ${error.operation}`);
      return false;
    },
    onSuccess: (result) => {
      if (result.exitCode !== 0) {
        logSafe(
          "warn",
          `git fetch failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        );
      }
      return result.exitCode === 0;
    },
  }),
);

export type PendingCommit = { sha: string; subject: string };

// Commit subjects are remote-authored free text that gets echoed to the
// user's real terminal (the startup check prints them unprompted) —
// strip control bytes so an embedded ESC/OSC sequence can't retitle or
// spoof the terminal. Same posture as sanitizeWorkNote for work notes.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1f\x7f]/g;

/** Commits an update would bring in (`HEAD..<ref>`, default @{u}), newest first. */
export const pendingCommits = (
  ref = "@{u}",
): Effect.Effect<PendingCommit[]> =>
  gitOk(["log", "--format=%H %s", `HEAD..${ref}`]).pipe(
    Effect.map((out) =>
      out
        ? out
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const sp = line.indexOf(" ");
              return sp === -1
                ? { sha: line, subject: "" }
                : {
                    sha: line.slice(0, sp),
                    subject: line.slice(sp + 1).replace(CONTROL_RE, " "),
                  };
            })
        : [],
    ),
  );

// ── Decisions (pure — tested in update.test.ts) ────────────────────────

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type StartupGate = "run" | "local-changes" | "rate-limited";

/**
 * Should the startup check fetch at all? Local divergence (dirty /
 * ahead / no upstream) means the human is driving this clone by hand —
 * skip silently: wt never touches a clone it might fight with. The
 * rate limit bounds the check (and its network fetch) to once a day; a
 * future `lastCheckAt` (clock rollback) falls through to "run" so a
 * bad stamp can't wedge the check forever.
 */
export function startupCheckGate(
  state: Pick<RepoUpdateState, "dirty" | "ahead" | "upstream">,
  memory: Pick<UpdateMemory, "lastCheckAt">,
  now: number,
): StartupGate {
  if (state.dirty || state.ahead > 0 || state.upstream === null) return "local-changes";
  if (
    memory.lastCheckAt !== null &&
    now >= memory.lastCheckAt &&
    now - memory.lastCheckAt < UPDATE_CHECK_INTERVAL_MS
  ) {
    return "rate-limited";
  }
  return "run";
}

export type OfferDecision =
  | { action: "up-to-date"; target: null }
  | { action: "none-eligible"; target: null }
  | { action: "declined"; target: string }
  | { action: "offer"; target: string };

/**
 * After a fetch refreshed the counts and the CI gate picked a target:
 * what to do. `target` is the newest eligible sha (null = the gate
 * found none), which may be older than origin's head. Declines compare
 * against the target — declining a head doesn't silence a later, newer
 * target, and a decline is void once the gate picks anything else.
 */
export function selectOffer(args: {
  behind: number;
  target: string | null;
  declinedSha: string | null;
}): OfferDecision {
  if (args.behind === 0) return { action: "up-to-date", target: null };
  if (args.target === null) return { action: "none-eligible", target: null };
  if (args.declinedSha !== null && args.declinedSha === args.target) {
    return { action: "declined", target: args.target };
  }
  return { action: "offer", target: args.target };
}

/**
 * PIDs of other live interactive wt instances (bare `main.ts`, no
 * subcommand argv) — they keep running the pre-update code until
 * restarted, so update/rollback name them. Path-anchored to THIS
 * clone; the bare `bun src/main.ts` dev form is accepted as-is (no
 * path to verify, and a false positive only adds an informational
 * line).
 */
export const listRunningWtInstances: Effect.Effect<number[]> =
  runIn(["ps", "-axo", "pid=,command="], {
    cwd: WT_REPO_ROOT,
    timeoutMs: 10_000,
  }).pipe(
    Effect.map((result) => {
      if (result.exitCode !== 0) return [];
      const pids: number[] = [];
      for (const line of result.stdout.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);
        if (!match?.[1] || match[2] === undefined) continue;
        const pid = parseInt(match[1], 10);
        if (pid === process.pid) continue;
        const command = match[2].trim();
        const isThisClone =
          command.endsWith("/src/main.ts") && command.includes(WT_REPO_ROOT);
        if (isThisClone || /^bun src\/main\.ts$/.test(command)) pids.push(pid);
      }
      return pids;
    }),
    Effect.orElseSucceed(() => []),
  );
