/**
 * `wt issue` — show or edit a worktree's issue links. The PRIMARY id
 * is parsed from the slug (never stored, never editable here); the
 * SECONDARY GitHub issue is a per-slug wtstate record, attached when a
 * spec/breakout issue is created mid-work.
 */
import {
  githubIssueUrl,
  issueIdForSlug,
  issueUrlForSlug,
} from "../../core/issue-tracker.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { readWtState, setSlugGithubIssue } from "../../core/wtstate.ts";
import { cyan, dim, green, red } from "../colors.ts";

const USAGE = `usage: wt issue <slug>              show the worktree's issue ids + urls
       wt issue <slug> --gh <n>     attach GitHub issue #n as the secondary id
       wt issue <slug> --clear-gh   detach the secondary GitHub issue

<slug> also accepts a branch name. The primary id comes from the slug
(eng-1935-… → ENG-1935); --gh never changes the branch.`;

export async function run(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (!first || first === "--help" || first === "-h") {
    console.log(USAGE);
    return first ? 0 : 2;
  }

  const slugOrBranch = first;
  const wts = (await listWorktrees()).filter((w) => !w.isMain);
  const wt = wts.find(
    (w) => w.slug === slugOrBranch || w.branch === slugOrBranch,
  );
  if (!wt) {
    console.error(red(`no worktree: ${slugOrBranch}`));
    return 1;
  }

  if (rest[0] === "--gh") {
    const n = Number(rest[1]);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(red("--gh requires an issue number"));
      return 2;
    }
    setSlugGithubIssue(wt.slug, n);
    console.log(green(`✓ ${wt.slug} ← gh issue #${n}`));
    const url = githubIssueUrl(n);
    if (url) console.log(`  ${dim(url)}`);
    return 0;
  }
  if (rest[0] === "--clear-gh") {
    setSlugGithubIssue(wt.slug, null);
    console.log(green(`✓ ${wt.slug} gh issue cleared`));
    return 0;
  }
  if (rest.length > 0) {
    console.error(red(`unknown args: ${rest.join(" ")}`));
    console.log(USAGE);
    return 2;
  }

  const id = issueIdForSlug(wt.slug);
  const gh = readWtState().slugs[wt.slug]?.githubIssue ?? null;
  console.log(`${cyan(wt.slug)}`);
  console.log(
    `  ${dim("issue:")} ${id ?? dim("—")}${id ? `  ${dim(issueUrlForSlug(wt.slug) ?? "")}` : ""}`,
  );
  console.log(
    `  ${dim("gh:")}    ${gh ? `#${gh}  ${dim(githubIssueUrl(gh) ?? "")}` : dim("—")}`,
  );
  return 0;
}
