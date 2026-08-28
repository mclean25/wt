import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { config } from "../../core/config.ts";
import { hasRepositoryState, importRepositorySnapshot } from "../../core/state-db.ts";
import { listWorktrees } from "../../core/worktree.ts";
import {
  GROUP_ARCHIVED,
  GROUP_INBOX,
  STACK_SECTION_PREFIX,
  parseWtState,
  readWtState,
  type WtState,
} from "../../core/wtstate.ts";
import { withWtStateLock } from "../../core/wtstate/io.ts";
import { remoteWorktreeLedgerPrefix } from "../../core/worktree-ref.ts";
import { hasHelpFlag } from "../args.ts";

const USAGE = `usage: wt state migrate [--from <legacy-cache-dir>] [--keep-legacy]

Import this repository's records from the legacy shared state.json and
archive.json into the global SQLite state database. The source files are
backed up first. By default, only successfully imported live records are
pruned from the legacy files; --keep-legacy leaves them untouched.

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
    Object.values(slugs).flatMap((value) => value.section ? [value.section] : []),
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
      pausedStacks: legacy.pausedStacks.filter((branch) => liveBranches.has(branch)),
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
    foldedSections: unique([...current.foldedSections, ...legacy.foldedSections]),
    pausedStacks: unique([...current.pausedStacks, ...legacy.pausedStacks]),
    automationsPaused: currentExists ? current.automationsPaused : legacy.automationsPaused,
    attentionSeenTs: currentExists ? current.attentionSeenTs : legacy.attentionSeenTs,
    edges: [...edges.values()],
    removed: current.removed,
    branchTips: current.branchTips,
  };
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
    Array.isArray(raw.slugs) ? raw.slugs.filter((value): value is string => typeof value === "string") : [],
  );
}

async function migrate(legacyDir: string, keepLegacy: boolean): Promise<number> {
  const statePath = join(legacyDir, "state.json");
  const archivePath = join(legacyDir, "archive.json");
  if (!existsSync(statePath) && !existsSync(archivePath)) {
    console.log(`no legacy state found in ${legacyDir}`);
    return 0;
  }

  const worktrees = await listWorktrees();
  const live = new Map(worktrees.map((worktree) => [worktree.slug, worktree.branch]));
  const legacy = existsSync(statePath)
    ? parseWtState(JSON.parse(readFileSync(statePath, "utf8")))
    : parseWtState({});
  const selection = selectLegacyState(legacy, live);
  const legacyArchive = parseArchive(archivePath);
  const remotePrefix = config.remote ? remoteWorktreeLedgerPrefix(config.remote.host) : null;
  const selectedArchive = new Set(
    [...legacyArchive].filter((key) => live.has(key) || (remotePrefix !== null && key.startsWith(remotePrefix))),
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backups = [backup(statePath, stamp), backup(archivePath, stamp)].filter(Boolean);
  withWtStateLock(() => {
    const currentExists = hasRepositoryState();
    const merged = mergeMigratedState(selection.state, readWtState(), currentExists);
    importRepositorySnapshot(JSON.stringify(merged), selectedArchive);
  });

  if (!keepLegacy) {
    if (existsSync(statePath)) {
      const remaining: WtState = {
        ...legacy,
        slugs: Object.fromEntries(
          Object.entries(legacy.slugs).filter(([slug]) => !selection.selectedSlugs.has(slug)),
        ),
        edges: legacy.edges.filter(
          (edge) => !selection.selectedSlugs.has(edge.from) && !selection.selectedSlugs.has(edge.to),
        ),
      };
      atomicJson(statePath, remaining);
    }
    if (existsSync(archivePath)) {
      for (const key of selectedArchive) legacyArchive.delete(key);
      atomicJson(archivePath, { slugs: [...legacyArchive].sort() });
    }
  }

  console.log(`migrated ${selection.selectedSlugs.size} worktree records to ${config.paths.stateDb}`);
  console.log(`repository ${config.repoId} (${config.repoPath})`);
  console.log(`migrated ${selectedArchive.size} archive flags`);
  if (legacy.removed.length > 0 || Object.keys(legacy.branchTips).length > 0) {
    console.log("left unscoped removed history and branch watermarks in the legacy backup");
  }
  if (backups.length > 0) console.log(`backups: ${backups.join(", ")}`);
  if (keepLegacy) console.log("legacy records retained (--keep-legacy)");
  return 0;
}

export async function run(argv: string[]): Promise<number> {
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
  return migrate(legacyDir, keepLegacy);
}
