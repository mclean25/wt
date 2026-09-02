import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";

import { config } from "../../core/config.ts";
import { operationErrors, type OperationError } from "../../core/errors.ts";
import { createLogger } from "../../core/logger.ts";
import { latestLogFor } from "../../core/logs.ts";
import { listWorktrees, type WorktreeError } from "../../core/worktree.ts";
import { hasHelpFlag } from "../args.ts";
import { dim, red } from "../colors.ts";

const USAGE = `usage: wt logs [<slug>]

Tail a destroy log (\`tail -F\`). No slug ⇒ the most recently modified
log.`;

const log = createLogger("wt logs");

type TailProcess = {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(): void;
};

export type LogsDeps = {
  readonly listWorktrees: typeof listWorktrees;
  readonly latestLogFor: typeof latestLogFor;
  readonly existsSync: typeof existsSync;
  readonly spawnTail: (logPath: string) => TailProcess;
};

const defaultDeps: LogsDeps = {
  listWorktrees: listWorktrees,
  latestLogFor,
  existsSync,
  spawnTail: (logPath) =>
    Bun.spawn(["tail", "-n", "200", "-F", logPath], {
      stdout: "inherit",
      stderr: "inherit",
    }),
};

const io = operationErrors("wt logs");

/** Newest log across *any* slug — used for `wt logs` with no arg. */
const mostRecentLog = Effect.fnUntraced(function* (): Effect.fn.Return<string | null, never> {
  const dir = config.paths.logDir;
  const exists = yield* io.sync("check log directory", () => existsSync(dir)).pipe(
    Effect.catch((error) => {
      log.debug("log directory check failed, treating as absent", { error: error.message });
      return Effect.succeed(false);
    }),
  );
  if (!exists) return null;
  const files = yield* io.sync("read log directory", () => readdirSync(dir)).pipe(
    Effect.catch((error) => {
      log.debug("log directory read failed, treating as empty", { error: error.message });
      return Effect.succeed([] as string[]);
    }),
  );
  const entries = yield* Effect.all(
    files
      .filter((f) => f.endsWith(".log"))
      .map((name) =>
        io.sync(`stat log ${name}`, () => ({
          name,
          mtime: statSync(join(dir, name)).mtimeMs,
        })).pipe(
          // A log can vanish between readdir and stat (startup reap) — skip it.
          Effect.catch(() => Effect.succeed(null)),
        ),
      ),
    { concurrency: "unbounded" },
  );
  const matching = entries
    .filter(
      (entry): entry is { name: string; mtime: number } => entry !== null,
    )
    .sort((a, b) => b.mtime - a.mtime);
  return matching[0] ? join(dir, matching[0].name) : null;
});

const cleanupTail = Effect.fnUntraced(function* (process: TailProcess): Effect.fn.Return<void, never> {
  yield* Effect.sync(() => {
    if (process.exitCode !== null) return;
    try {
      process.kill();
    } catch {
      // Best effort; awaiting `exited` below still reaps an already-dead child.
    }
  });
  yield* Effect.promise(() => process.exited.then(
    () => undefined,
    () => undefined,
  ));
});

export const tailLog = Effect.fn("wt logs tail")(function* (
  logPath: string,
  spawnTail: LogsDeps["spawnTail"],
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Effect.acquireRelease(
        io.sync("spawn tail", () => spawnTail(logPath)),
        cleanupTail,
      );
      return yield* io.promise("wait for tail", () => process.exited);
    }),
  );
});

export const runWithDeps = Effect.fn("wt logs")(function* (
  argv: string[],
  deps: LogsDeps,
): Effect.fn.Return<number, OperationError | WorktreeError> {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const slug = argv.find((a) => !a.startsWith("-")) ?? null;

  let logPath: string | null = null;
  if (slug) {
    const wts = yield* deps.listWorktrees();
    const match = wts.find((w) => w.slug === slug);
    if (match) {
      logPath = yield* io.sync("find latest log", () => deps.latestLogFor(match.slug));
    }
  } else {
    logPath = yield* mostRecentLog();
  }
  if (!logPath) {
    // "No destroy logs found" is true and is almost never the question.
    // This command gets reached by someone whose SESSION misbehaved,
    // for whom a destroy log was never the right artifact — so say what
    // this command covers, and name the two places the other answers
    // live. Both were unfindable when a Claude start failed to
    // register: the reader had a true sentence about the wrong subject
    // and nowhere else to look.
    console.log(
      dim(slug ? `No destroy logs for ${slug}.` : "No destroy logs found."),
    );
    console.log(
      dim("(destroy logs only — a session's own output is `wt claude ls`"),
    );
    console.log(
      dim(
        ` and its pane; wt's own log is ${join(config.paths.logDir, "app")}/wt-<date>.log)`,
      ),
    );
    return 1;
  }
  if (!(yield* io.sync("check log file", () => deps.existsSync(logPath)))) {
    console.error(red(`Log file missing: ${logPath}`));
    return 1;
  }
  console.log(dim(`→ ${logPath}`));
  return yield* tailLog(logPath, deps.spawnTail);
});

export function run(argv: string[]): Effect.Effect<number, OperationError | WorktreeError> {
  return runWithDeps(argv, defaultDeps);
}
