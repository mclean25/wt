/**
 * `wt fleet` — the manager's single audit surface: one row per live
 * worktree joining the ASSERTED work status with observable REALITY
 * (live agent session, PR/merge/CI state), plus the recently-removed
 * rows every fleet surface appends. `--json` is the contract; the
 * human table is a convenience.
 *
 * PR reality comes from ONE batched GraphQL round trip through
 * `fetchGithub` (the same machinery the TUI uses) — never per-row gh
 * calls. GitHub computes `mergeable` lazily: `UNKNOWN` is reported as
 * "computing" and never retried here — the caller re-runs after a few
 * seconds if it cares (the query itself is what triggers the compute).
 */
import { revParse } from "../../core/git.ts";
import { fetchGithub, hasGh, pickPrForWorktree, repoSlug } from "../../core/github.ts";
import { readRegistry } from "../../core/harness/claude/registry.ts";
import { claudeAgentAddress } from "../../core/harness/index.ts";
import { listSessions } from "../../core/tmux.ts";
import type {
  MergeableState,
  MergeStateStatus,
  PullRequest,
  Worktree,
} from "../../core/types.ts";
import { listWorktrees } from "../../core/worktree.ts";
import {
  workAge,
  workStateRank,
  type WorkStatusRecord,
} from "../../core/work-status.ts";
import {
  readWtState,
  recentlyRemovedWorktrees,
  removedJsonEntry,
} from "../../core/wtstate.ts";
import { firstUnknownFlag, hasHelpFlag } from "../args.ts";
import { cyan, dim, green, magenta, red, yellow } from "../colors.ts";
import { renderTable } from "../render.ts";

const USAGE = `usage: wt fleet [--json]

The fleet audit: one row per live worktree joining the asserted work
status (state, note, risk, staleness) with reality — live agent
session (busy / last activity) and PR state (number, draft, merge
state, mergeability, CI rollup) from one batched GitHub query. The
human's manual TUI section rides along as asserted intent (a name
like "Merge after Release" is a merge-order hint; null/— = inbox).
Recently-removed rows (≤48h) are appended so "everything landed" never
reads as "nothing exists".

  --json    machine-readable array. Live rows carry work / session /
            pr objects (pr is null with a pr_note when GitHub is
            unavailable); removed rows carry kind: "merged"|"removed"
            instead (live rows never have a "kind" field).

Merge fields report "computing" while GitHub is still calculating
mergeability (its UNKNOWN state) — re-run after a few seconds; the
query itself is what triggers the computation.`;

const KNOWN_FLAGS = new Set(["--json", "--help", "-h"]);

/**
 * Lowercase GitHub's SCREAMING_CASE for the JSON contract, mapping the
 * lazily-computed `UNKNOWN` to "computing" — but only on OPEN PRs. On
 * terminal PRs GitHub reports UNKNOWN forever (there is nothing left
 * to compute), so the fields are suppressed rather than lying
 * "computing" for eternity.
 */
function mergeField(
  v: MergeableState | MergeStateStatus | null | undefined,
  prState: PullRequest["state"],
): string | null {
  if (!v || prState !== "OPEN") return null;
  return v === "UNKNOWN" ? "computing" : v.toLowerCase();
}

type SessionInfo = {
  alive: boolean;
  busy: boolean | null;
  last_activity: string | null;
  /** Address for direct peer-to-peer messaging; null = use `wt claude send`. */
  agent_name: string | null;
};

/**
 * Per-worktree primary-session liveness, from the same two signals
 * `wt claude ls --json` joins: tmux (alive) and Claude's process
 * registry (busy / last_activity, matched by cwd + name; see
 * commands/claude.ts for the name-leg rationale). Worktree primaries
 * register under the slug; "primary" and null are the pre-slug-naming
 * forms, still matched so a session started before that change (or by
 * hand, without `--name`) keeps reporting liveness.
 */
function sessionInfoFor(
  wt: Worktree,
  liveClaudeSlugs: ReadonlySet<string>,
  registry: ReturnType<typeof readRegistry>,
): SessionInfo {
  const alive = liveClaudeSlugs.has(wt.slug);
  if (!alive) return { alive: false, busy: null, last_activity: null, agent_name: null };
  const match = registry
    .filter(
      (r) => r.cwd === wt.path && (r.name === wt.slug || r.name === "primary" || r.name === null),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  return {
    alive: true,
    busy: match ? match.status === "busy" || match.status === "shell" : null,
    last_activity:
      match && match.updatedAt > 0 ? new Date(match.updatedAt).toISOString() : null,
    agent_name: claudeAgentAddress(match?.name, wt.slug),
  };
}

/**
 * The one batched PR fetch, degraded to a note instead of a crash when
 * GitHub is unreachable: no gh / no resolvable repo yields a
 * self-describing note (fetchGithub would silently return empty maps,
 * indistinguishable from "no PRs"), and a thrown fetch (auth, rate
 * limit, network) becomes its first error line. Rows always emit.
 */
async function fetchFleetPrs(
  branches: string[],
): Promise<{ prs: Map<string, PullRequest>; note: string | null }> {
  if (!(await hasGh())) {
    return { prs: new Map(), note: "gh CLI not installed — PR data omitted" };
  }
  if (!(await repoSlug())) {
    return {
      prs: new Map(),
      note: "GitHub repo unresolvable (gh not authenticated, or no GitHub remote) — PR data omitted",
    };
  }
  try {
    return { prs: (await fetchGithub(branches)).prs, note: null };
  } catch (err) {
    return {
      prs: new Map(),
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

type FleetRow = {
  wt: Worktree;
  /** Manual TUI section (human intent — e.g. merge batching); null = inbox. */
  section: string | null;
  work: (WorkStatusRecord & { stale: boolean }) | null;
  session: SessionInfo;
  pr: PullRequest | undefined;
};

function workCell(row: FleetRow): string {
  if (!row.work) return dim("—");
  const color =
    row.work.state === "needs-human"
      ? red
      : row.work.state === "needs-testing"
        ? yellow
        : row.work.state === "ready"
          ? green
          : row.work.state === "review"
            ? magenta
            : row.work.state === "working"
              ? cyan
              : dim;
  const parts = [color(row.work.state)];
  if (row.work.risk) parts.push(dim(row.work.risk));
  const age = workAge(row.work.at);
  if (age) parts.push(dim(age));
  if (row.work.stale) parts.push(yellow("stale"));
  return parts.join(" ");
}

function agentCell(row: FleetRow): string {
  if (!row.session.alive) return dim("—");
  if (row.session.busy === null) return dim("live");
  return row.session.busy ? yellow("busy") : "idle";
}

function prCell(row: FleetRow): string {
  const pr = row.pr;
  if (!pr) return dim("—");
  const parts = [`#${pr.number}`];
  if (pr.state === "MERGED") parts.push(green("merged"));
  else if (pr.state === "CLOSED") parts.push(dim("closed"));
  else if (pr.isDraft) parts.push(dim("draft"));
  else parts.push("open");
  return parts.join(" ");
}

function mergeCell(row: FleetRow): string {
  const pr = row.pr;
  if (!pr || pr.state !== "OPEN") return dim("—");
  const state = mergeField(pr.mergeStateStatus, pr.state);
  const mergeable = mergeField(pr.mergeable, pr.state);
  if (!state && !mergeable) return dim("—");
  const paint = (v: string): string =>
    v === "clean" || v === "mergeable"
      ? green(v)
      : v === "dirty" || v === "conflicting" || v === "blocked"
        ? red(v)
        : v === "computing"
          ? dim(v)
          : yellow(v);
  return [state, mergeable]
    .filter((v): v is string => v !== null)
    .map(paint)
    .join(" ");
}

function ciCell(row: FleetRow): string {
  const pr = row.pr;
  if (!pr || pr.state !== "OPEN") return dim("—");
  switch (pr.checks) {
    case "pass":
      return green("pass");
    case "fail":
      return red("fail");
    case "pending":
      return yellow("pending");
    default:
      return dim("—");
  }
}

export async function run(argv: string[]): Promise<number> {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const unknown = firstUnknownFlag(argv, KNOWN_FLAGS);
  if (unknown) {
    console.error(red(`unknown flag: ${unknown}`));
    return 2;
  }
  const json = argv.includes("--json");

  const wts = (await listWorktrees()).filter((w) => !w.isMain);
  const slugStates = readWtState().slugs;
  const removed = recentlyRemovedWorktrees(new Set(wts.map((w) => w.slug)));
  const branches = wts.filter((w) => w.branch).map((w) => w.branch);

  // Independent realities in parallel: the batched GitHub round trip,
  // tmux session list, and one HEAD resolve per worktree (for status
  // staleness, same signal `wt status --all` uses).
  const [{ prs, note }, sessions, heads] = await Promise.all([
    fetchFleetPrs(branches),
    listSessions(),
    Promise.all(wts.map((w) => revParse("HEAD", w.path))),
  ]);
  const registry = readRegistry();
  const liveClaudeSlugs = new Set(
    sessions.claude.filter((e) => e.name === null).map((e) => e.slug),
  );

  const rows: FleetRow[] = wts.map((w, i) => {
    const record = slugStates[w.slug]?.work;
    const headSha = heads[i] ?? null;
    return {
      wt: w,
      section: slugStates[w.slug]?.section ?? null,
      work: record
        ? { ...record, stale: !!(record.sha && headSha && record.sha !== headSha) }
        : null,
      session: sessionInfoFor(w, liveClaudeSlugs, registry),
      pr: pickPrForWorktree(w, prs),
    };
  });
  // Urgency order, derived at render time (same ranking the TUI sorts
  // by): ready first, then needs-human, todo last.
  rows.sort(
    (a, b) =>
      workStateRank(a.work?.state) - workStateRank(b.work?.state) ||
      a.wt.slug.localeCompare(b.wt.slug),
  );

  if (json) {
    const payload = [
      ...rows.map((r) => ({
        slug: r.wt.slug,
        branch: r.wt.branch,
        path: r.wt.path,
        // The human's manual grouping in the TUI ("Merge after Release",
        // …) — asserted intent the manager should weigh; null = inbox.
        // Inferred stack groupings deliberately don't appear here: they
        // are derivable reality (base records + PRs), not assertion.
        section: r.section,
        work: r.work
          ? {
              state: r.work.state,
              note: r.work.note ?? null,
              risk: r.work.risk ?? null,
              at: r.work.at,
              stale: r.work.stale,
            }
          : null,
        session: r.session,
        pr: r.pr
          ? {
              number: r.pr.number,
              url: r.pr.url,
              title: r.pr.title,
              state: r.pr.state,
              draft: r.pr.isDraft,
              merge_state: mergeField(r.pr.mergeStateStatus, r.pr.state),
              mergeable: mergeField(r.pr.mergeable, r.pr.state),
              checks: r.pr.checks,
            }
          : null,
        // Distinguishes "no PR" (pr null, pr_note null) from "GitHub
        // unavailable" (pr null, pr_note says why).
        pr_note: r.pr ? null : note,
      })),
      ...removed.map(removedJsonEntry),
    ];
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  if (rows.length === 0 && removed.length === 0) {
    console.log(dim("No worktrees."));
    return 0;
  }
  if (rows.length > 0) {
    const table = renderTable(rows as unknown[], [
      { header: "slug", getter: (r) => cyan((r as FleetRow).wt.slug) },
      {
        header: "section",
        getter: (r) => dim((r as FleetRow).section ?? "—"),
      },
      { header: "work", getter: (r) => workCell(r as FleetRow) },
      { header: "agent", getter: (r) => agentCell(r as FleetRow) },
      { header: "pr", getter: (r) => prCell(r as FleetRow) },
      { header: "merge", getter: (r) => mergeCell(r as FleetRow) },
      { header: "ci", getter: (r) => ciCell(r as FleetRow) },
    ]);
    console.log(table);
  }
  if (note) console.log(dim(`note: ${note}`));
  if (removed.length > 0) {
    console.log("");
    console.log(dim("recently removed:"));
    for (const e of removed) {
      const entry = removedJsonEntry(e);
      const pr = entry.pr !== null ? ` #${entry.pr}` : "";
      const age = workAge(entry.archived_at);
      console.log(
        dim(`  ${entry.slug}  ${entry.kind}${pr}${age ? `, ${age} ago` : ""}`),
      );
    }
  }
  return 0;
}
