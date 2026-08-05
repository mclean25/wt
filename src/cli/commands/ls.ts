import { config } from "../../core/config.ts";
import { fetchPrs } from "../../core/github.ts";
import { githubIssueUrl, issueIdForSlug, issueUrlForSlug } from "../../core/issue-tracker.ts";
import { readWtState } from "../../core/wtstate.ts";
import type { Worktree } from "../../core/types.ts";
import { StatusKind } from "../../core/types.ts";
import {
  fetchOrigin,
  listWorktrees,
  unpushedCommits,
  worktreeStatus,
} from "../../core/worktree.ts";
import { dim } from "../colors.ts";
import {
  renderPrCell,
  renderSlugCell,
  renderStageCell,
  renderStatusCell,
  renderTable,
} from "../render.ts";
import { existsSync } from "node:fs";

export async function run(argv: string[]): Promise<number> {
  const jsonOut = argv.includes("--json");
  const all = await listWorktrees();
  const rows = all.filter((w) => !w.isMain);

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
          unpushed: dirty ? 0 : await unpushedCommits(w.path),
          issue_id: issueIdForSlug(w.slug),
          issue_url: issueUrlForSlug(w.slug),
          gh_issue: slugStates[w.slug]?.githubIssue ?? null,
          gh_issue_url: slugStates[w.slug]?.githubIssue
            ? githubIssueUrl(slugStates[w.slug]!.githubIssue!)
            : null,
        };
      }),
    );
    console.log(JSON.stringify(payload, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    console.log(dim("No worktrees."));
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
  return 0;
}
