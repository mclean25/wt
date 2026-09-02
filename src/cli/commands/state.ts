import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { config } from "../../core/config.ts";
import { isInsidePath } from "../../core/config-layer.ts";
import {
  hasRepositoryState,
  importRepositorySnapshot,
  readForeignRepositoryRows,
  type ForeignRepositoryRow,
} from "../../core/state-db.ts";
import { listWorktreesPromise } from "../../core/worktree.ts";
import {
  GROUP_ARCHIVED,
  GROUP_INBOX,
  STACK_SECTION_PREFIX,
  parseWtState,
  readWtState,
  type WtSlugState,
  type WtState,
} from "../../core/wtstate.ts";
import { withWtStateLock } from "../../core/wtstate/io.ts";
import { remoteWorktreeLedgerPrefix } from "../../core/worktree-ref.ts";
import { hasHelpFlag } from "../args.ts";
import { Data, Effect } from "effect";

export class StateCommandError extends Data.TaggedError("StateCommandError")<{
  operation: string;
  cause: unknown;
}> {}

const USAGE = `usage: wt state migrate [--from <legacy-cache-dir>] [--keep-legacy]

Import this repository's records from the legacy shared state.json and
archive.json into the global SQLite state database. The source files are
backed up first. By default, only successfully imported live records are
pruned from the legacy files; --keep-legacy leaves them untouched.

Also adopts records this repository owns that an earlier build filed under a
per-worktree namespace, or wrote into a second state database, when it derived
repository identity from the caller's working directory. Those sources are read
only, never written, and never deleted.

The command is idempotent and never overwrites newer SQLite values.`;

export type LegacySelection = {
  state: WtState;
  selectedSlugs: Set<string>;
};

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Select only facts that can be attributed to the current repository. */
export function selectLegacyState(
  legacy: WtState,
  live: ReadonlyMap<string, string>,
): LegacySelection {
  const selectedSlugs = new Set<string>();
  const slugs: WtState["slugs"] = {};
  for (const [slug, value] of Object.entries(legacy.slugs)) {
    if (!live.has(slug)) continue;
    selectedSlugs.add(slug);
    slugs[slug] = value;
  }
  const manualSections = new Set(
    Object.values(slugs).flatMap((value) =>
      value.section ? [value.section] : [],
    ),
  );
  const liveBranches = new Set(live.values());
  const ownsSection = (section: string): boolean =>
    section === GROUP_INBOX ||
    section === GROUP_ARCHIVED ||
    manualSections.has(section) ||
    (section.startsWith(STACK_SECTION_PREFIX) &&
      liveBranches.has(section.slice(STACK_SECTION_PREFIX.length)));

  return {
    selectedSlugs,
    state: {
      ...legacy,
      slugs,
      sectionsOrder: legacy.sectionsOrder.filter(ownsSection),
      foldedSections: legacy.foldedSections.filter(ownsSection),
      pausedStacks: legacy.pausedStacks.filter((branch) =>
        liveBranches.has(branch),
      ),
      removed: [], // a removed slug has no remaining repository identity
      edges: legacy.edges.filter(
        (edge) => selectedSlugs.has(edge.from) && selectedSlugs.has(edge.to),
      ),
      branchTips: {}, // branch names alone are not repository identities
    },
  };
}

export function mergeMigratedState(
  legacy: WtState,
  current: WtState,
  currentExists = false,
): WtState {
  const edgeKey = (edge: WtState["edges"][number]): string =>
    `${edge.kind}\0${edge.from}\0${edge.to}`;
  const edges = new Map(legacy.edges.map((edge) => [edgeKey(edge), edge]));
  for (const edge of current.edges) edges.set(edgeKey(edge), edge);
  return {
    ...legacy,
    ...current,
    slugs: { ...legacy.slugs, ...current.slugs },
    sectionsOrder: unique([...current.sectionsOrder, ...legacy.sectionsOrder]),
    foldedSections: unique([
      ...current.foldedSections,
      ...legacy.foldedSections,
    ]),
    pausedStacks: unique([...current.pausedStacks, ...legacy.pausedStacks]),
    automationsPaused: currentExists
      ? current.automationsPaused
      : legacy.automationsPaused,
    attentionSeenTs: currentExists
      ? current.attentionSeenTs
      : legacy.attentionSeenTs,
    edges: [...edges.values()],
    removed: current.removed,
    branchTips: current.branchTips,
  };
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * State databases an earlier build could have written this repository into.
 *
 * Both defaults are listed unconditionally rather than the one this build
 * would pick, because which one got written was a function of the CWD the
 * command happened to run from — the whole defect. The per-repository cache
 * roots are swept too: a namespace derived from a worktree put its database
 * under that worktree's id.
 */
export function candidateStateDatabases(
  home: string,
  current: string,
): string[] {
  const cacheRoot = join(home, ".cache", "wt");
  const candidates = [
    current,
    join(home, ".local", "state", "wt", "wt.sqlite"),
    join(cacheRoot, "wt.sqlite"),
  ];
  try {
    for (const entry of readdirSync(cacheRoot, { withFileTypes: true })) {
      if (entry.isDirectory())
        candidates.push(join(cacheRoot, entry.name, "wt.sqlite"));
    }
  } catch {
    // No cache root yet — nothing to sweep.
  }
  const seen = new Set<string>();
  return candidates.filter((path) => {
    const key = canonical(path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Rows that describe THIS repository under some other identity.
 *
 * Two shapes, one cause. A row whose `repo_path` is the repository itself is
 * this repository in the wrong FILE. A row whose `repo_path` is inside
 * `worktree_root` is a worktree that a cwd-derived namespace mistook for a
 * repository of its own. The repository's own current row is excluded by
 * identity, so re-running adopts nothing new.
 */
export function selectStrandedRows(
  rows: readonly (ForeignRepositoryRow & { source: string })[],
  opts: {
    repoId: string;
    repoPath: string;
    worktreeRoot: string;
    currentDb: string;
  },
): (ForeignRepositoryRow & { source: string })[] {
  const repoPath = canonical(opts.repoPath);
  const currentDb = canonical(opts.currentDb);
  return rows
    .filter((row) => {
      const isCurrent =
        row.repoId === opts.repoId && canonical(row.source) === currentDb;
      if (isCurrent) return false;
      const path = canonical(row.repoPath);
      return path === repoPath || isInsidePath(opts.worktreeRoot, path);
    })
    .sort((a, b) => a.updatedAt - b.updatedAt);
}

/**
 * Adopt a stranded snapshot into the current one.
 *
 * `mergeMigratedState` replaces whole slug records, which is right when the
 * source is a legacy file the current state SUPERSEDES. A stranded namespace is
 * not superseded, it is a sibling: the same worktree accumulated a work status
 * in one namespace and a tracker id in the other, and a whole-record winner
 * silently drops half of it. So the record merges FIELD-wise, current winning
 * every field it actually has. Absent means absent — an `issueId` of `""` is
 * the deliberate "this worktree has no ticket" and must not read as a gap.
 */
export function mergeAdoptedState(stray: WtState, current: WtState): WtState {
  const merged = mergeMigratedState(stray, current, true);
  const slugs: WtState["slugs"] = { ...merged.slugs };
  for (const [slug, strayValue] of Object.entries(stray.slugs)) {
    const currentValue = current.slugs[slug];
    if (!currentValue) {
      slugs[slug] = strayValue;
      continue;
    }
    const filled: Record<string, unknown> = { ...currentValue };
    for (const [key, value] of Object.entries(strayValue)) {
      if (filled[key] === undefined) filled[key] = value;
    }
    // `section` is the one field a parse never leaves undefined — absent reads
    // as `null`, meaning Inbox — so gap-filling by undefined alone would drop
    // every manual section the human arranged in the other namespace. Named
    // explicitly rather than treating null as a gap everywhere: a null that
    // MEANS something is exactly the trap `issueId: ""` is, and a blanket rule
    // would walk into it the first time a nullable field is added.
    if (currentValue.section === null && strayValue.section !== null) {
      filled.section = strayValue.section;
    }
    slugs[slug] = filled as WtSlugState;
  }
  return { ...merged, slugs };
}

/**
 * Runtime files that live beside the query cache and are NOT rebuildable from
 * the world.
 *
 * A repository that gained its own namespace also gained a new cache root, and
 * these four do not regenerate into it correctly. `automations.json` is the
 * once-only fire ledger: an empty one is not a slow start, it is every
 * satisfied condition firing a second time. `harness.json` is the primary
 * harness the human picked with Tab, and losing it silently reverts to the
 * configured default. The two session registries are the managed conversation
 * NAMES — without them a cold start opens a new conversation instead of
 * resuming the one the row has been holding all along.
 *
 * Everything else under a cache root is deliberately absent from this list:
 * logs, locks, the query cache, inspector sockets, shims and the generated
 * tmux.conf are all either disposable or regenerated on demand, and the
 * manager spool is a delivery channel whose contents are meant to expire.
 */
const CARRY_WHOLE = ["automations.json", "harness.json"] as const;
const CARRY_MERGED = ["claude-sessions.json", "codex-sessions.json"] as const;

/**
 * Union two session-name registries, the destination winning every conflict.
 *
 * Shapes differ per harness (`{slug: string[]}` for Claude, `{slug: {uuid:
 * label}}` for Codex), so this merges structurally rather than knowing either.
 */
export function mergeRegistries(legacy: unknown, current: unknown): unknown {
  if (Array.isArray(legacy) && Array.isArray(current)) {
    return [...new Set([...current, ...legacy])];
  }
  if (!isPlainObject(legacy) || !isPlainObject(current))
    return current ?? legacy;
  const merged: Record<string, unknown> = { ...legacy };
  for (const [key, value] of Object.entries(current)) {
    merged[key] = key in legacy ? mergeRegistries(legacy[key], value) : value;
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function carryLegacyRuntime(legacyDir: string, cacheRoot: string): string[] {
  if (canonical(legacyDir) === canonical(cacheRoot)) return [];
  const carried: string[] = [];
  for (const name of CARRY_WHOLE) {
    const from = join(legacyDir, name);
    const to = join(cacheRoot, name);
    // Never overwrite: the destination is the live one, and a file that is
    // already there has been maintained under the new namespace.
    if (!existsSync(from) || existsSync(to)) continue;
    mkdirSync(cacheRoot, { recursive: true });
    copyFileSync(from, to);
    carried.push(name);
  }
  for (const name of CARRY_MERGED) {
    const from = join(legacyDir, name);
    const to = join(cacheRoot, name);
    const legacy = existsSync(from) ? readJson(from) : null;
    if (legacy === null) continue;
    const current = existsSync(to) ? readJson(to) : null;
    const merged = mergeRegistries(legacy, current ?? {});
    if (JSON.stringify(merged) === JSON.stringify(current)) continue;
    mkdirSync(cacheRoot, { recursive: true });
    atomicJson(to, merged);
    carried.push(name);
  }
  return carried;
}

function atomicJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

function backup(path: string, stamp: string): string | null {
  if (!existsSync(path)) return null;
  const destination = `${path}.bak-sqlite-${stamp}`;
  copyFileSync(path, destination);
  return destination;
}

function parseArchive(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  const raw = JSON.parse(readFileSync(path, "utf8")) as { slugs?: unknown };
  return new Set(
    Array.isArray(raw.slugs)
      ? raw.slugs.filter((value): value is string => typeof value === "string")
      : [],
  );
}

function migrate(
  legacyDir: string,
  keepLegacy: boolean,
): Effect.Effect<number, StateCommandError> {
  return Effect.gen(function* () {
    const worktrees = yield* Effect.tryPromise({
      try: () => listWorktreesPromise(),
      catch: (cause) =>
        new StateCommandError({ operation: "list worktrees", cause }),
    });
    return yield* Effect.try({
      try: () => {
        const statePath = join(legacyDir, "state.json");
        const archivePath = join(legacyDir, "archive.json");
        // No early return when the legacy JSON is absent: the sqlite adoption and
        // runtime carry below are the phases most users need, and a machine that
        // already migrated its JSON once has neither file left to find.
        const hasLegacyJson = existsSync(statePath) || existsSync(archivePath);
        if (!hasLegacyJson)
          console.log(`no legacy state.json/archive.json in ${legacyDir}`);

        const live = new Map(
          worktrees.map((worktree) => [worktree.slug, worktree.branch]),
        );
        const legacy = existsSync(statePath)
          ? parseWtState(JSON.parse(readFileSync(statePath, "utf8")))
          : parseWtState({});
        const selection = selectLegacyState(legacy, live);
        const legacyArchive = parseArchive(archivePath);
        const remotePrefix = config.remote
          ? remoteWorktreeLedgerPrefix(config.remote.host)
          : null;
        const selectedArchive = new Set(
          [...legacyArchive].filter(
            (key) =>
              live.has(key) ||
              (remotePrefix !== null && key.startsWith(remotePrefix)),
          ),
        );

        const stranded = selectStrandedRows(
          candidateStateDatabases(homedir(), config.paths.stateDb).flatMap(
            (source) =>
              readForeignRepositoryRows(source).map((row) => ({
                ...row,
                source,
              })),
          ),
          {
            repoId: config.repoId,
            repoPath: config.repoPath,
            worktreeRoot: config.paths.worktreeRoot,
            currentDb: config.paths.stateDb,
          },
        );

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const backups = [
          backup(statePath, stamp),
          backup(archivePath, stamp),
        ].filter(Boolean);
        const adoptedArchive = new Set(selectedArchive);
        const adoptedFrom: string[] = [];
        withWtStateLock(() => {
          const currentExists = hasRepositoryState();
          let merged = mergeMigratedState(
            selection.state,
            readWtState(),
            currentExists,
          );
          for (const row of stranded) {
            let selected: LegacySelection;
            try {
              selected = selectLegacyState(
                parseWtState(JSON.parse(row.data)),
                live,
              );
            } catch {
              // Unreadable stray snapshot: adopting nothing is the safe direction.
              continue;
            }
            const archived = [...row.archived].filter((key) => live.has(key));
            if (selected.selectedSlugs.size === 0 && archived.length === 0)
              continue;
            merged = mergeAdoptedState(selected.state, merged);
            for (const key of archived) adoptedArchive.add(key);
            adoptedFrom.push(row.repoId);
          }
          importRepositorySnapshot(JSON.stringify(merged), adoptedArchive);
        });

        if (!keepLegacy) {
          if (existsSync(statePath)) {
            const remaining: WtState = {
              ...legacy,
              slugs: Object.fromEntries(
                Object.entries(legacy.slugs).filter(
                  ([slug]) => !selection.selectedSlugs.has(slug),
                ),
              ),
              edges: legacy.edges.filter(
                (edge) =>
                  !selection.selectedSlugs.has(edge.from) &&
                  !selection.selectedSlugs.has(edge.to),
              ),
            };
            atomicJson(statePath, remaining);
          }
          if (existsSync(archivePath)) {
            for (const key of selectedArchive) legacyArchive.delete(key);
            atomicJson(archivePath, { slugs: [...legacyArchive].sort() });
          }
        }

        console.log(
          `migrated ${selection.selectedSlugs.size} worktree records to ${config.paths.stateDb}`,
        );
        console.log(`repository ${config.repoId} (${config.repoPath})`);
        console.log(`migrated ${adoptedArchive.size} archive flags`);
        const carried = carryLegacyRuntime(legacyDir, config.paths.cacheRoot);
        if (carried.length > 0) {
          console.log(
            `carried ${carried.join(", ")} into ${config.paths.cacheRoot}`,
          );
        }
        if (adoptedFrom.length > 0) {
          console.log(
            `adopted ${adoptedFrom.length} stranded namespace(s): ${adoptedFrom.join(", ")}`,
          );
          console.log(
            "(left in place and unchanged; current values won every conflict)",
          );
        }
        if (
          legacy.removed.length > 0 ||
          Object.keys(legacy.branchTips).length > 0
        ) {
          console.log(
            "left unscoped removed history and branch watermarks in the legacy backup",
          );
        }
        if (backups.length > 0) console.log(`backups: ${backups.join(", ")}`);
        if (keepLegacy) console.log("legacy records retained (--keep-legacy)");
        return 0;
      },
      catch: (cause) =>
        new StateCommandError({ operation: "migrate state", cause }),
    });
  });
}

export function run(argv: string[]): Effect.Effect<number, StateCommandError> {
  return Effect.gen(function* () {
    if (hasHelpFlag(argv) || argv.length === 0) {
      console.log(USAGE);
      return argv.length === 0 ? 2 : 0;
    }
    if (argv[0] !== "migrate") {
      console.error(`unknown state command: ${argv[0]}\n\n${USAGE}`);
      return 2;
    }
    let legacyDir = join(homedir(), ".cache", "wt");
    let keepLegacy = false;
    for (let i = 1; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === "--keep-legacy") keepLegacy = true;
      else if (arg === "--from" && argv[i + 1]) legacyDir = resolve(argv[++i]!);
      else {
        console.error(`unknown or incomplete option: ${arg}\n\n${USAGE}`);
        return 2;
      }
    }
    return yield* migrate(legacyDir, keepLegacy);
  });
}
