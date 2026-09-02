import { Data, Effect } from "effect";

import { config } from "../../core/config.ts";
import { categorizeStages, humanSize, listSstStages } from "../../core/sst.ts";
import type { SstStage } from "../../core/types.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { cyan, dim, green, red, yellow } from "../colors.ts";
import { humanAge } from "../../core/locks.ts";
import { renderTable } from "../render.ts";
import { confirm, isInteractive, type PromptError } from "../prompt.ts";
import { firstUnknownFlag, hasHelpFlag } from "../args.ts";

const USAGE = `usage: wt stages [options]

List SST stages in the configured state bucket and flag orphans (no
matching live worktree). Requires [deploy.sst].

  --clean       destroy orphaned stages (\`sst remove\` per stage, in the
                main clone)
  --yes, -y     skip the destroy confirmation
  --json        machine-readable {live, orphaned}`;

const KNOWN_FLAGS = new Set([
  "--json",
  "--clean",
  "--yes",
  "-y",
  "--help",
  "-h",
]);

function parseFlags(argv: string[]): {
  json: boolean;
  clean: boolean;
  yes: boolean;
} {
  return {
    json: argv.includes("--json"),
    clean: argv.includes("--clean"),
    yes: argv.includes("--yes") || argv.includes("-y"),
  };
}

function ageOf(s: SstStage, now: number): string {
  const t = Date.parse(s.lastModified);
  if (Number.isNaN(t)) return "?";
  return humanAge((now - t) / 1000);
}

export class StagesCommandError extends Data.TaggedError("StagesCommandError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

type StageProcess = {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(): void;
};

function commandIo<A>(
  operation: string,
  f: () => A,
): Effect.Effect<A, StagesCommandError> {
  return Effect.try({
    try: f,
    catch: (cause) => new StagesCommandError({ operation, cause }),
  });
}

function commandPromise<A>(
  operation: string,
  f: () => Promise<A>,
): Effect.Effect<A, StagesCommandError> {
  return Effect.tryPromise({
    try: f,
    catch: (cause) => new StagesCommandError({ operation, cause }),
  });
}

function cleanupProcess(process: StageProcess): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    yield* Effect.sync(() => {
      if (process.exitCode !== null) return;
      try {
        process.kill();
      } catch {
        // Awaiting `exited` below still reaps an already-dead process.
      }
    });
    yield* Effect.promise(() => process.exited.then(
      () => undefined,
      () => undefined,
    ));
  });
}

function removeStage(name: string): Effect.Effect<number, StagesCommandError> {
  return Effect.scoped(
    Effect.gen(function* () {
      const process = yield* Effect.acquireRelease(
        commandIo("spawn sst remove", () =>
          Bun.spawn(["pnpm", "sst", "remove", "--stage", name], {
            cwd: config.paths.mainClone,
            stdout: "inherit",
            stderr: "inherit",
          }),
        ),
        cleanupProcess,
      );
      return yield* commandPromise("wait for sst remove", () => process.exited);
    }),
  );
}

export function run(
  argv: string[],
): Effect.Effect<number, StagesCommandError | PromptError> {
  return Effect.gen(function* () {
    if (hasHelpFlag(argv)) {
      console.log(USAGE);
      return 0;
    }
    const unknown = firstUnknownFlag(argv, KNOWN_FLAGS);
    if (unknown) {
      console.error(red(`unknown flag: ${unknown}`));
      return 2;
    }
    const { json, clean, yes } = parseFlags(argv);

    if (!config.sst) {
      // Optional integration absent, not a usage error — 1, matching
      // dev/events/remote's guard for their own optional sections.
      console.error(
        red("[deploy.sst] is not configured in config.toml; nothing to do."),
      );
      return 1;
    }

    const stages = yield* listSstStages().pipe(
      Effect.mapError((cause) =>
        new StagesCommandError({ operation: "list SST stages", cause }),
      ),
    );
    if (!stages) {
      console.error(red("Failed to list SST state bucket."));
      return 1;
    }
    const wts = yield* listWorktrees().pipe(
      Effect.mapError((cause) =>
        new StagesCommandError({ operation: "list worktrees", cause }),
      ),
    );
    const worktreeStages = new Set(
      wts.filter((w) => !w.isMain).map((w) => w.stage),
    );
    const { live, orphaned } = yield* categorizeStages(
      stages,
      worktreeStages,
    ).pipe(
      Effect.mapError((cause) =>
        new StagesCommandError({ operation: "categorize SST stages", cause }),
      ),
    );

    if (json) {
      console.log(
        JSON.stringify(
          {
            live: live.map((s) => ({
              name: s.name,
              size_bytes: s.sizeBytes,
              modified: s.lastModified,
            })),
            orphaned: orphaned.map((s) => ({
              name: s.name,
              size_bytes: s.sizeBytes,
              modified: s.lastModified,
            })),
          },
          null,
          2,
        ),
      );
    } else if (live.length === 0 && orphaned.length === 0) {
      console.log(
        dim(
          `No \`${config.stage.prefix}*\` stages in ${config.sst.stateBucket}.`,
        ),
      );
    } else {
      const now = Date.now();
      type Row = { marker: string; stage: SstStage; status: string };
      const rows: Row[] = [
        ...orphaned.map((s) => ({
          marker: yellow("⚠"),
          stage: s,
          status: yellow("orphaned"),
        })),
        ...live.map((s) => ({
          marker: green("✓"),
          stage: s,
          status: green("live"),
        })),
      ];
      const table = renderTable(rows, [
        { header: "", getter: (r) => (r as Row).marker },
        { header: "stage", getter: (r) => cyan((r as Row).stage.name) },
        {
          header: "size",
          getter: (r) => dim(humanSize((r as Row).stage.sizeBytes)),
        },
        { header: "age", getter: (r) => dim(ageOf((r as Row).stage, now)) },
        { header: "status", getter: (r) => (r as Row).status },
      ]);
      console.log(table);
      console.log(
        dim(
          `  ${live.length} live · ${orphaned.length} orphaned · bucket ${config.sst.stateBucket}`,
        ),
      );
    }

    if (!clean) return 0;
    if (orphaned.length === 0) {
      if (!json) console.log(green("No orphans to clean."));
      return 0;
    }
    if (!yes) {
      if (!isInteractive()) {
        console.error(red("Use -y with --clean in non-interactive mode."));
        return 2;
      }
      if (
        !(yield* confirm(
          `Destroy ${orphaned.length} orphaned stage(s)?`,
          false,
        ))
      ) {
        return 0;
      }
    }
    for (const s of orphaned) {
      console.log();
      console.log(`--- Destroying ${red(s.name)} ---`);
      const code = yield* removeStage(s.name);
      if (code === 0) console.log(green(`✓ destroyed ${s.name}`));
      else console.log(red(`✗ ${s.name} failed (exit ${code}); continuing`));
    }
    return 0;
  });
}
