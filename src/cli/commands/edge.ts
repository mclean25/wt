/**
 * `wt edge` — assert, list, and drop merge edges: pairwise,
 * self-expiring ordering hints between worktrees ("merge A before B").
 * Vocabulary and design rules live in `core/merge-edges.ts`; the fleet
 * intent (why edges are pairwise + decaying rather than a maintained
 * ordering) is docs/fleet.md. Like `wt status`, the output teaches:
 * asserts confirm the decay contract, errors restate the vocabulary.
 */
import {
  edgeIsStaleBySha,
  MERGE_EDGE_KINDS,
  type MergeEdge,
  type MergeEdgeKind,
  type MergeEdgeStrength,
} from "../../core/merge-edges.ts";
import { Clock, DateTime, Effect } from "effect";
import { operationErrors } from "../../core/errors.ts";
import { revParse } from "../../core/git.ts";
import type { Worktree } from "../../core/types.ts";
import { workAge } from "../../core/work-status.ts";
import { listWorktrees, worktreeAtCwd } from "../../core/worktree.ts";
import {
  pruneMergeEdges,
  recentlyRemovedWorktrees,
  readWtState,
  removeMergeEdge,
  setMergeEdge,
} from "../../core/wtstate.ts";
import { hasHelpFlag } from "../args.ts";
import { cyan, dim, green, red } from "../colors.ts";

const USAGE = `usage: wt edge [<from> <kind> <to>] [options]

Merge edges: pairwise, self-expiring ordering hints between worktrees.
An edge records what someone knows about ONE pair — never a total
ordering. The TUI sorts rows within their section to honor fresh
edges; the manager and \`wt fleet --json\` read them for merge planning.

  assert   wt edge <from> <kind> <to> [--blocks|--prefer] [-m why]
  list     wt edge [--json]
  drop     wt edge rm <from> <to>
  prune    wt edge prune            drop edges whose endpoint is gone

kinds (unique prefixes accepted):
  before     merge <from> before <to> (risk ordering)
  enables    <from> landing makes <to>'s claims true; orders like before
  conflicts  the pair touches the same files — sequence them, direction
             irrelevant; does not affect ordering

  --blocks   hard dependency (default is --prefer, a preference that's
             safe to violate deliberately)
  -m <why>   one line for the human deciding whether to honor it

Edges SELF-EXPIRE: each records both endpoints' HEAD at assert time,
and once either branch moves the edge goes stale — greyed here,
ignored by ordering — until re-asserted. Nobody maintains edges; a
merged or destroyed endpoint drops its edges entirely. Absence of an
edge means "no known constraint", never "safe".`;

const io = operationErrors("wt edge");

function findWorktree(wts: Worktree[], slugOrBranch: string): Worktree | null {
  return (
    wts.find((w) => w.slug === slugOrBranch || w.branch === slugOrBranch) ??
    null
  );
}

function resolveKind(input: string): MergeEdgeKind | null {
  const matches = MERGE_EDGE_KINDS.filter((k) => k.startsWith(input));
  return matches.length === 1 ? matches[0]! : null;
}

function fmtEdge(e: MergeEdge & { stale: boolean }): string {
  const arrow = e.kind === "conflicts" ? "×" : "▶";
  const paint = e.stale ? dim : (s: string): string => s;
  const strength = e.strength === "blocks" ? red(e.strength) : dim(e.strength);
  const age = workAge(e.at);
  const head = `${cyan(e.from)} ${paint(`─${e.kind}`)}${e.stale ? dim(" (stale)") : ""}${paint(`─${arrow}`)} ${cyan(e.to)}`;
  const meta = [strength, age ? dim(`${age} ago`) : null, dim(`by ${e.by}`)]
    .filter(Boolean)
    .join(dim(" · "));
  const why = e.why ? `\n    ${dim(e.why)}` : "";
  return `${head}   ${meta}${why}`;
}

export const run = Effect.fn("wt edge")(function* (argv: string[]) {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const positional: string[] = [];
  let strength: MergeEdgeStrength = "prefer";
  let why: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--blocks") strength = "blocks";
    else if (a === "--prefer") strength = "prefer";
    else if (a === "-m" || a === "--message") {
      const message = argv[i + 1];
      if (message === undefined || message.startsWith("-")) {
        console.error(red(`${a} requires a message`));
        return 2;
      }
      why = message;
      i++;
    } else if (a === "--json") json = true;
    else if (a.startsWith("-")) {
      console.error(red(`unknown flag: ${a}`));
      return 2;
    } else positional.push(a);
  }

  const wts = (yield* listWorktrees()).filter((w) => !w.isMain);

  // List (default).
  if (positional.length === 0) {
    const edges = (yield* io.sync("read wt state", readWtState)).edges;
    if (edges.length === 0) {
      if (json) console.log("[]");
      else
        console.log(
          dim("No edges. Assert one: wt edge <from> before <to> -m <why>"),
        );
      return 0;
    }
    // One HEAD resolve per referenced endpoint for staleness.
    const heads = new Map<string, string | null>();
    yield* Effect.all(
      [...new Set(edges.flatMap((e) => [e.from, e.to]))].map((slug) =>
        Effect.gen(function* () {
          const wt = wts.find((w) => w.slug === slug);
          const head = wt ? yield* revParse("HEAD", wt.path) : null;
          heads.set(slug, head);
        }),
      ),
      { concurrency: "unbounded" },
    );
    const withStale = edges.map((e) => ({
      ...e,
      stale: edgeIsStaleBySha(e, (s) => heads.get(s) ?? null),
    }));
    if (json) {
      console.log(JSON.stringify(withStale, null, 2));
      return 0;
    }
    for (const e of withStale) console.log(fmtEdge(e));
    return 0;
  }

  // Prune: wt edge prune — drop every edge whose endpoint is no longer
  // a live worktree. This otherwise only happens at the startup reap,
  // so edges pointing at branches that merged hours ago keep listing
  // (harmlessly — staleness already stops them steering — but they read
  // as unfinished business, and `rm` is awkward for them because the
  // endpoint no longer resolves).
  if (positional[0] === "prune") {
    const live = new Set(wts.map((w) => w.slug));
    const before = (yield* io.sync("read wt state", readWtState)).edges;
    const dead = before.filter((e) => !live.has(e.from) || !live.has(e.to));
    if (dead.length === 0) {
      console.log(dim("No edges with dead endpoints."));
      return 0;
    }
    yield* io.sync("prune merge edges", () => pruneMergeEdges(live));
    for (const e of dead) {
      console.log(
        `${green("✓")} dropped ${cyan(e.from)} → ${cyan(e.to)} ${dim("(endpoint gone)")}`,
      );
    }
    return 0;
  }

  // Drop: wt edge rm <from> <to>
  if (positional[0] === "rm") {
    const [, fromArg, toArg] = positional;
    if (!fromArg || !toArg || positional.length !== 3) {
      console.error(red("usage: wt edge rm <from> <to>"));
      return 2;
    }
    // Endpoints are stored as slugs, and `findWorktree` only resolves a
    // LIVE worktree — so once a branch merges and its worktree is gone,
    // a branch-name argument stops resolving and the exact-pair match
    // misses, which is precisely when someone is trying to clean up.
    // The removed-worktree history still carries slug+branch, so it
    // resolves the endpoints `rm` would otherwise be unable to name.
    const edges = (yield* io.sync("read wt state", readWtState)).edges;
    const removed = yield* io.sync("read removed worktrees", () =>
      recentlyRemovedWorktrees(new Set(wts.map((w) => w.slug))),
    );
    const resolveEndpoint = (arg: string): string =>
      findWorktree(wts, arg)?.slug ??
      removed.find((r) => r.slug === arg || r.branch === arg)?.slug ??
      arg;
    const from = resolveEndpoint(fromArg);
    const to = resolveEndpoint(toArg);
    if (yield* io.sync("remove merge edge", () => removeMergeEdge(from, to))) {
      console.log(`${green("✓")} dropped ${from} → ${to}`);
      return 0;
    }
    console.error(red(`no edge ${from} → ${to}`));
    // Never fail silently about WHY: the usual causes are direction
    // (edges are ordered pairs) and naming a branch whose worktree is
    // gone, and both are invisible without seeing the real keys.
    const related = edges.filter(
      (e) => [e.from, e.to].includes(from) || [e.from, e.to].includes(to),
    );
    if (related.length > 0) {
      console.error(dim("edges referencing either endpoint:"));
      for (const e of related)
        console.error(dim(`  ${e.from} ─${e.kind}─▶ ${e.to}`));
    } else if (edges.length > 0) {
      console.error(
        dim(
          `${edges.length} edge(s) exist, none touching those endpoints — \`wt edge\` lists them`,
        ),
      );
    }
    return 1;
  }

  // Assert: wt edge <from> <kind> <to>
  if (positional.length !== 3) {
    console.error(
      red("expected: wt edge <from> <before|conflicts|enables> <to>"),
    );
    console.log(USAGE);
    return 2;
  }
  const [fromArg, kindArg, toArg] = positional as [string, string, string];
  const kind = resolveKind(kindArg);
  if (!kind) {
    console.error(
      red(`unknown kind: ${kindArg} (before, conflicts, enables)`),
    );
    return 2;
  }
  const from = findWorktree(wts, fromArg);
  const to = findWorktree(wts, toArg);
  if (!from || !to) {
    console.error(red(`no such worktree: ${!from ? fromArg : toArg}`));
    return 1;
  }
  if (from.slug === to.slug) {
    console.error(red("an edge needs two different worktrees"));
    return 2;
  }
  // The decay anchors are mandatory: an edge that can't self-expire is
  // worse than no edge (it would look authoritative while drifting).
  const [fromSha, toSha] = yield* Effect.all(
    [revParse("HEAD", from.path), revParse("HEAD", to.path)],
    { concurrency: "unbounded" },
  );
  if (!fromSha || !toSha) {
    console.error(
      red(
        `cannot resolve HEAD of ${!fromSha ? from.slug : to.slug} — refusing an edge with no decay anchor`,
      ),
    );
    return 1;
  }
  const by = worktreeAtCwd(wts)?.slug ?? "fleet";
  const nowMs = yield* Clock.currentTimeMillis;
  const edge: MergeEdge = {
    from: from.slug,
    to: to.slug,
    kind,
    strength,
    at: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
    by,
    fromSha,
    toSha,
  };
  if (why?.trim()) edge.why = why.trim();
  yield* io.sync("set merge edge", () => setMergeEdge(edge));
  if (json) {
    console.log(JSON.stringify(edge));
    return 0;
  }
  const arrow = kind === "conflicts" ? "×" : "▶";
  console.log(
    `${green("✓")} ${cyan(from.slug)} ─${kind}─${arrow} ${cyan(to.slug)} (${strength}${edge.why ? `: ${edge.why}` : ""})`,
  );
  console.log(
    dim(
      "» expires when either branch moves; re-assert then if it still matters",
    ),
  );
  if (strength === "prefer" && kind === "before") {
    console.log(
      dim(
        "» preference, not a gate — safe to merge out of order deliberately",
      ),
    );
  }
  return 0;
});
