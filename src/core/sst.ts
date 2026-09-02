import { config, requireSst } from "./config.ts";
import { Data, Effect } from "effect";
import { createLogger } from "./logger.ts";
import { runEffect } from "./proc.ts";
import type { SstStage } from "./types.ts";

const log = createLogger("[sst]");

class SstStateParseError extends Data.TaggedError("SstStateParseError")<{
  readonly stage: string;
  readonly cause: unknown;
}> {}

/**
 * Run `aws s3 ...` with the configured profile. Throws if SST is not
 * configured — callers are expected to gate on `config.sst` first
 * (see `cli/commands/stages.ts` for the user-facing message).
 */
export function awsS3Effect(args: readonly string[]) {
  const sst = requireSst();
  return runEffect(["aws", "s3", ...args, "--profile", sst.awsProfile]).pipe(
    Effect.map((r) => ({ stdout: r.stdout, ok: r.exitCode === 0 })),
  );
}
export const awsS3 = (args: string[]) => Effect.runPromise(awsS3Effect(args));

/** List stages from the SST state bucket. Returns null on failure. */
export function listSstStagesEffect() {
  const sst = requireSst();
  return Effect.gen(function* () {
    const r = yield* awsS3Effect(["ls", `s3://${sst.stateBucket}/${sst.statePrefix}`]);
    if (!r.ok) return null;
    const stages: SstStage[] = [];
    for (const line of r.stdout.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;
      const date = parts[0]!;
      const time = parts[1]!;
      const sizeS = parts[2]!;
      const name = parts[3]!;
      if (!name.endsWith(".json")) continue;
      const size = parseInt(sizeS, 10);
      if (Number.isNaN(size)) continue;
      stages.push({
        name: name.slice(0, -".json".length),
        sizeBytes: size,
        lastModified: `${date}T${time}Z`,
      });
    }
    return stages;
  });
}
export const listSstStages = (): Promise<SstStage[] | null> => Effect.runPromise(listSstStagesEffect());

/**
 * True if the stage's state file lists any resources. `sst remove`
 * leaves a small empty state file; without this check dead stages get
 * repeatedly flagged as orphans.
 */
function stageHasResourcesEffect(name: string) {
  const sst = requireSst();
  return Effect.gen(function* () {
    const r = yield* awsS3Effect([
      "cp",
      `s3://${sst.stateBucket}/${sst.statePrefix}${name}.json`,
      "-",
    ]);
    if (!r.ok) return true; // be conservative on read failure
    return yield* Effect.try({
      try: () => {
        const state = JSON.parse(r.stdout);
        const resources = state?.checkpoint?.latest?.resources ?? [];
        return Array.isArray(resources) && resources.length > 0;
      },
      catch: (cause) => new SstStateParseError({ stage: name, cause }),
    }).pipe(Effect.catchAll((err) => Effect.sync(() => {
      log.error(err, { stage: name });
      return true;
    })));
  });
}

export function categorizeStagesEffect(
  stages: SstStage[],
  worktreeStages: Set<string>,
) {
  return Effect.gen(function* () {
    const live: SstStage[] = [];
    const orphaned: SstStage[] = [];
    for (const s of stages) {
      if (s.name === config.stage.defaultPersonal) continue;
      if (!s.name.startsWith(config.stage.prefix)) continue;
      if (worktreeStages.has(s.name)) {
        live.push(s);
        continue;
      }
      if (!(yield* stageHasResourcesEffect(s.name))) continue;
      orphaned.push(s);
    }
    orphaned.sort((a, b) => (b.lastModified > a.lastModified ? 1 : -1));
    live.sort((a, b) => a.name.localeCompare(b.name));
    return { live, orphaned };
  });
}
export const categorizeStages = (stages: SstStage[], worktreeStages: Set<string>) =>
  Effect.runPromise(categorizeStagesEffect(stages, worktreeStages));

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
