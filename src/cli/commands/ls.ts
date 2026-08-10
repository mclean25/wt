import { config } from "../../core/config.ts";
import { fetchPrs } from "../../core/github.ts";
import { githubIssueUrl, issueIdForSlug, issueUrlForSlug } from "../../core/issue-tracker.ts";
import { workAge } from "../../core/work-status.ts";
import {
  isMergedRemoval,
  readWtState,
  recentlyRemovedWorktrees,
  recentRemovalsSummary,
  removedJsonEntry,
} from "../../core/wtstate.ts";
import type { Worktree } from "../../core/types.ts";
import { StatusKind } from "../../core/types.ts";
import {
  fetchOrigin,
  listWorktrees,
  unpushedCommits,
  worktreeStatus,
} from "../../core/worktree.ts";
import { firstUnknownFlag, hasHelpFlag } from "../args.ts";
import { dim, red } from "../colors.ts";
import {
  renderPrCell,
  renderSlugCell,
  renderStageCell,
  renderStatusCell,
  renderTable,
} from "../render.ts";
import { existsSync } from "node:fs";

const USAGE = `usage: wt ls [options]

List all non-main worktrees (slug, stage when [deploy.sst] is
configured, PR, status). Worktrees destroyed in the last 48h stay
visible as a dim "recently merged" footer, so an empty fleet says why.

  --json    machine-readable array (slug, branch, path, stage, status,
            dirty, issue_id, issue_url, …). Recently-removed rows are
            appended with kind: "merged"|"removed", pr, archived_at;
            live rows never carry a "kind" field.`;

const KNOWN_FLAGS = new Set(["--json", "--help", "-h"]);

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
  const jsonOut = argv.includes("--json");
  const all = await listWorktrees();
  const rows = all.filter((w) => !w.isMain);
  // Recently-destroyed rows (≤48h, from the existing removed history)
  // ride every output shape so "everything merged" is distinguishable
  // from "no worktrees exist" — the manager's core empty-fleet question.
  const recentRemoved = recentlyRemovedWorktrees(new Set(rows.map((w) => w.slug)));

  if (jsonOut) {
    const slugStates = readWtState().slugs;
    const payload = await Promise.all(
      rows.map(async (w) => {
        const st = await worktreeStatus(w);
        const dirty = st.kind === StatusKind.Dirty;
        return {
          slug: w.slug,
          branch: w.branch,
          path: w.path,
          stage: w.stage,
          exists: existsSync(w.path),
          status: st.kind,
          status_label: st.label,
          status_age: st.age ?? null,
          status_op: st.op ?? null,
          dirty,
          // null = couldn't determine (see unpushedCommits) — surfaced
          // as-is so JSON consumers can distinguish it from 0.
          unpushed: dirty ? 0 : await unpushedCommits(w.path),
          issue_id: issueIdForSlug(w.slug),
          issue_url: issueUrlForSlug(w.slug),
          gh_issue: slugStates[w.slug]?.githubIssue ?? null,
          gh_issue_url: slugStates[w.slug]?.githubIssue
            ? githubIssueUrl(slugStates[w.slug]!.githubIssue!)
            : null,
          // Work status (agent-asserted; see `wt status`). Rides this
          // payload so `remoteWorktreesQuery` (the remote host's
          // `wt ls --json`) carries statuses across SSH for free.
          work_state: slugStates[w.slug]?.work?.state ?? null,
          work_note: slugStates[w.slug]?.work?.note ?? null,
          work_risk: slugStates[w.slug]?.work?.risk ?? null,
          work_at: slugStates[w.slug]?.work?.at ?? null,
        };
      }),
    );
    console.log(
      JSON.stringify([...payload, ...recentRemoved.map(removedJsonEntry)], null, 2),
    );
    return 0;
  }

  if (rows.length === 0) {
    const summary = recentRemovalsSummary(recentRemoved);
    console.log(dim(summary ? `No active worktrees (${summary}).` : "No worktrees."));
    return 0;
  }

  // Parallel: PR fetch, origin fetch, status checks. Status needs fresh
  // refs, so await fetch first.
  const [prs] = await Promise.all([fetchPrs(), fetchOrigin()]);
  const statuses = await Promise.all(rows.map((w) => worktreeStatus(w)));

  type Row = { wt: Worktree; idx: number };
  const tableRows: Row[] = rows.map((wt, idx) => ({ wt, idx }));
  const table = renderTable(tableRows, [
    { header: "slug", getter: (r) => renderSlugCell((r as Row).wt) },
    // Stage only means something with an SST integration; a column of
    // "(not deployed)" on a non-SST repo is pure noise.
    ...(config.sst
      ? [{ header: "stage", getter: (r: unknown) => renderStageCell((r as Row).wt) }]
      : []),
    { header: "pr", getter: (r) => renderPrCell((r as Row).wt, prs) },
    { header: "", getter: (r) => renderStatusCell(statuses[(r as Row).idx]!) },
  ]);
  console.log(table);
  // Dim footer of what just landed — merged removals only (non-merged
  // removals aren't fleet news; they still appear in --json and the
  // TUI's `h` view).
  const recentMerged = recentRemoved.filter(isMergedRemoval);
  if (recentMerged.length > 0) {
    console.log("");
    console.log(dim("recently merged:"));
    for (const e of recentMerged) {
      const pr = e.prNumber !== undefined ? `#${e.prNumber} ` : "";
      const age = workAge(e.removedAt);
      console.log(dim(`  ${e.slug}  ${pr}merged${age ? `, archived ${age} ago` : ""}`));
    }
  }
  return 0;
}
