import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Data, Effect } from "effect";

import { config } from "../../core/config.ts";
import { latestLogFor } from "../../core/logs.ts";
import { listWorktreesEffect } from "../../core/worktree.ts";
import { hasHelpFlag } from "../args.ts";
import { dim, red } from "../colors.ts";

const USAGE = `usage: wt logs [<slug>]

Tail a destroy log (\`tail -F\`). No slug ⇒ the most recently modified
log.`;

export class LogsCommandError extends Data.TaggedError("LogsCommandError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type TailProcess = {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(): void;
};

export type LogsDeps = {
  readonly listWorktrees: typeof listWorktreesEffect;
  readonly latestLogFor: typeof latestLogFor;
  readonly existsSync: typeof existsSync;
  readonly spawnTail: (logPath: string) => TailProcess;
};

const defaultDeps: LogsDeps = {
  listWorktrees: listWorktreesEffect,
  latestLogFor,
  existsSync,
  spawnTail: (logPath) =>
    Bun.spawn(["tail", "-n", "200", "-F", logPath], {
      stdout: "inherit",
      stderr: "inherit",
    }),
};

function commandIo<A>(
  operation: string,
  f: () => A,
): Effect.Effect<A, LogsCommandError> {
  return Effect.try({
    try: f,
    catch: (cause) => new LogsCommandError({ operation, cause }),
  });
}

function commandPromise<A>(
  operation: string,
  f: () => Promise<A>,
): Effect.Effect<A, LogsCommandError> {
  return Effect.tryPromise({
    try: f,
    catch: (cause) => new LogsCommandError({ operation, cause }),
  });
}

/** Newest log across *any* slug — used for `wt logs` with no arg. */
function mostRecentLog(): Effect.Effect<string | null, never> {
  return Effect.gen(function* () {
    const dir = config.paths.logDir;
    const exists = yield* commandIo("check log directory", () =>
      existsSync(dir),
    ).pipe(Effect.catchTag("LogsCommandError", () => Effect.succeed(false)));
    if (!exists) return null;
    const files = yield* commandIo("read log directory", () =>
      readdirSync(dir),
    ).pipe(
      Effect.catchTag("LogsCommandError", () => Effect.succeed([] as string[])),
    );
    const entries = yield* Effect.all(
      files
        .filter((f) => f.endsWith(".log"))
        .map((name) =>
          commandIo(`stat log ${name}`, () => ({
            name,
            mtime: statSync(join(dir, name)).mtimeMs,
          })).pipe(
            // A log can vanish between readdir and stat (startup reap) — skip it.
            Effect.catchTag("LogsCommandError", () => Effect.succeed(null)),
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
}

function cleanupTail(process: TailProcess): Effect.Effect<void, never> {
  return Effect.gen(function* () {
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
}

export function tailLog(
  logPath: string,
  spawnTail: LogsDeps["spawnTail"],
): Effect.Effect<number, LogsCommandError, never> {
  return Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Effect.acquireRelease(
        commandIo("spawn tail", () => spawnTail(logPath)),
        cleanupTail,
      );
      return yield* commandPromise("wait for tail", () => process.exited);
    }),
  );
}

export function runWithDeps(
  argv: string[],
  deps: LogsDeps,
): Effect.Effect<number, LogsCommandError> {
  return Effect.gen(function* () {
    if (hasHelpFlag(argv)) {
      console.log(USAGE);
      return 0;
    }
    const slug = argv.find((a) => !a.startsWith("-")) ?? null;

    let logPath: string | null = null;
    if (slug) {
      const wts = yield* deps.listWorktrees().pipe(
        Effect.mapError((cause) =>
          new LogsCommandError({ operation: "list worktrees", cause }),
        ),
      );
      const match = wts.find((w) => w.slug === slug);
      if (match) {
        logPath = yield* commandIo("find latest log", () =>
          deps.latestLogFor(match.slug),
        );
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
    if (!(yield* commandIo("check log file", () => deps.existsSync(logPath)))) {
      console.error(red(`Log file missing: ${logPath}`));
      return 1;
    }
    console.log(dim(`→ ${logPath}`));
    return yield* tailLog(logPath, deps.spawnTail);
  });
}

export function run(argv: string[]): Effect.Effect<number, LogsCommandError> {
  return runWithDeps(argv, defaultDeps);
}
