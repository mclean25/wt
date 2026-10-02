import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { Effect, Stream } from "effect";

import { operationErrors } from "./errors.ts";

const io = operationErrors("worktree file copy");

/** Join each write before interruption can release the creation lock. */
const copyMissing = Effect.fnUntraced(function* (source: string, destination: string) {
  yield* io.promise(`create ${dirname(destination)}`, () => mkdir(dirname(destination), { recursive: true }));
  return yield* io.promise(`copy ${source}`, () => copyFile(source, destination, constants.COPYFILE_EXCL)).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => (error.cause as NodeJS.ErrnoException)?.code === "EEXIST",
      () => Effect.succeed(false),
    ),
  );
}, Effect.uninterruptible);

/** Async traversal and bounded writes keep large copy_globs off the TUI thread. */
export const copyWorktreeFiles = Effect.fn("copyWorktreeFiles")(function* (
  source: string,
  destination: string,
  files: readonly string[],
  patterns: readonly string[],
  onLog?: (line: string) => void,
) {
  for (const name of files) {
    const copied = yield* copyMissing(join(source, name), join(destination, name)).pipe(
      Effect.catchIf(
        (error) => (error.cause as NodeJS.ErrnoException)?.code === "ENOENT",
        () => Effect.succeed(false),
      ),
    );
    if (copied) onLog?.(`copied ${name}`);
  }

  const copied = new Set<string>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(pattern);
    yield* Stream.fromAsyncIterable(
      glob.scan({ cwd: source, dot: true, onlyFiles: true }),
      io.wrap(`scan ${pattern}`),
    ).pipe(Stream.runForEach((relativePath) => Effect.gen(function* () {
      const name = normalize(relativePath);
      if (/^\.git(?:[\\/]|$)/.test(name) || copied.has(name)) return;
      copied.add(name);
      if (yield* copyMissing(join(source, name), join(destination, name))) {
        onLog?.(`copied ${name}`);
      }
    })));
  }
});
