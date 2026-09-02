import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Clock, Data, Effect } from "effect";

import { config } from "./config.ts";
import { runEffect } from "./proc.ts";

export class ZedWindowError extends Data.TaggedError("ZedWindowError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

/**
 * Zed 0.20x changed `zed <path>` to reuse the current window instead of
 * focusing the one that already has <path> open. Zed's CLI has no flag
 * for the old smart-focus behavior, and its SQLite `workspaces` table
 * records its own internal `window_id` which isn't the macOS AX id, so
 * we can't map DB → yabai directly.
 *
 * Workaround: track the yabai window id we got on each `zed -n` spawn.
 * Next time the user asks to open the same path, we focus by id via
 * yabai, which is the only way to pick a specific window when Zed's AX
 * titles collide (which they do in practice right after an update).
 */

const CACHE_FILE = join(config.paths.cacheRoot, "zed-windows.json");

type CacheEntry = { windowId: number; lastSeen: string };
type CacheFile = { byPath: Record<string, CacheEntry> };

type YabaiWindow = {
  id: number;
  pid: number;
  app: string;
};

function readCache(): CacheFile {
  if (!existsSync(CACHE_FILE)) return { byPath: {} };
  try {
    const raw = readFileSync(CACHE_FILE, "utf8");
    const data = JSON.parse(raw) as CacheFile;
    return { byPath: data?.byPath ?? {} };
  } catch {
    return { byPath: {} };
  }
}

function writeCache(cache: CacheFile): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
}

function yabaiQueryAllWindowsEffect(): Effect.Effect<YabaiWindow[] | null> {
  return runEffect(["yabai", "-m", "query", "--windows"]).pipe(
    Effect.map((r) => {
      if (r.exitCode !== 0) return null;
      try {
        const parsed = JSON.parse(r.stdout) as YabaiWindow[];
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }),
    Effect.catchAll(() => Effect.succeed(null)),
  );
}

function zedWindowIdsEffect(): Effect.Effect<Set<number>> {
  return yabaiQueryAllWindowsEffect().pipe(
    Effect.map((all) =>
      new Set((all ?? []).filter((w) => w.app === "Zed").map((w) => w.id)),
    ),
  );
}

function yabaiWindowExistsEffect(id: number): Effect.Effect<boolean> {
  return runEffect([
    "yabai",
    "-m",
    "query",
    "--windows",
    "--window",
    String(id),
  ]).pipe(
    Effect.map((r) => {
      if (r.exitCode !== 0) return false;
      try {
        const w = JSON.parse(r.stdout) as YabaiWindow;
        return w?.app === "Zed";
      } catch {
        return false;
      }
    }),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

function yabaiFocusEffect(id: number): Effect.Effect<boolean> {
  return runEffect(["yabai", "-m", "window", "--focus", String(id)]).pipe(
    Effect.map((r) => r.exitCode === 0),
    Effect.catchAll(() => Effect.succeed(false)),
  );
}

/**
 * Resolve a worktree path to its tracked yabai window id, if one is
 * known and still alive. Prunes the cache on miss so stale entries
 * don't accumulate.
 */
export function findZedWindowForPathEffect(
  path: string,
): Effect.Effect<number | null, ZedWindowError> {
  return Effect.gen(function* () {
    const cache = readCache();
    const entry = cache.byPath[path];
    if (!entry) return null;
    if (yield* yabaiWindowExistsEffect(entry.windowId)) return entry.windowId;
    delete cache.byPath[path];
    yield* Effect.try({
      try: () => writeCache(cache),
      catch: (cause) => new ZedWindowError({ operation: "prune cache", cause }),
    });
    return null;
  });
}

export function findZedWindowForPath(path: string): Promise<number | null> {
  return Effect.runPromise(findZedWindowForPathEffect(path));
}

export function focusYabaiWindowEffect(id: number): Effect.Effect<boolean> {
  return yabaiFocusEffect(id);
}

export function focusYabaiWindow(id: number): Promise<boolean> {
  return Effect.runPromise(focusYabaiWindowEffect(id));
}

export function waitForNewZedWindowEffect(
  beforeIds: ReadonlySet<number>,
  query: () => Effect.Effect<Set<number>> = zedWindowIdsEffect,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Effect.Effect<number | null> {
  const intervalMs = options.intervalMs ?? 150;
  const timeoutMs = options.timeoutMs ?? 3000;
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    while ((yield* Clock.currentTimeMillis) - startedAt < timeoutMs) {
      yield* Effect.sleep(intervalMs);
      const now = yield* query();
      for (const id of now) if (!beforeIds.has(id)) return id;
    }
    return null;
  });
}

function spawnZedEffect(path: string): Effect.Effect<void, ZedWindowError> {
  return Effect.async<void, ZedWindowError>((resume) => {
    let child: ReturnType<typeof spawn>;
    let settled = false;
    try {
      child = spawn("zed", ["-n", path], { stdio: "ignore", detached: true });
    } catch (cause) {
      resume(Effect.fail(new ZedWindowError({ operation: "spawn", cause })));
      return;
    }
    const onSpawn = () => {
      settled = true;
      child.unref();
      resume(Effect.void);
    };
    const onError = (cause: unknown) => {
      settled = true;
      resume(Effect.fail(new ZedWindowError({ operation: "spawn", cause })));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    return Effect.sync(() => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      if (!settled) child.kill();
    });
  });
}

/**
 * Spawn a detached `zed -n <path>`, then poll yabai until a new Zed
 * window appears (one not present in `beforeIds`). Records the id in
 * the cache so the next lookup for this path focuses it.
 *
 * Returns once we either find the new window id or give up. The detached
 * launch waits for Node's definitive spawn/error event, and the tracking
 * poll uses Effect's clock so interruption and tests are deterministic.
 */
export function spawnZedAndTrackEffect(
  path: string,
): Effect.Effect<void, ZedWindowError> {
  return Effect.gen(function* () {
    const beforeIds = yield* zedWindowIdsEffect();
    yield* spawnZedEffect(path);
    const id = yield* waitForNewZedWindowEffect(beforeIds);
    if (id === null) return;
    const now = yield* Clock.currentTimeMillis;
    const cache = readCache();
    cache.byPath[path] = {
      windowId: id,
      lastSeen: new Date(now).toISOString(),
    };
    yield* Effect.try({
      try: () => writeCache(cache),
      catch: (cause) => new ZedWindowError({ operation: "write cache", cause }),
    });
  });
}

export function spawnZedAndTrack(path: string): Promise<void> {
  return Effect.runPromise(spawnZedAndTrackEffect(path));
}
