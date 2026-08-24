/**
 * `wt issue` — show or edit a worktree's issue links. The PRIMARY id
 * is parsed from the slug (never stored, never editable here); the
 * SECONDARY GitHub issue is a per-slug wtstate record, attached when a
 * spec/breakout issue is created mid-work.
 */
import {
  ISSUE_ID_RE,
  githubIssueUrl,
  issueIdForSlug,
  issueUrlForId,
  resolveIssueId,
} from "../../core/issue-tracker.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { readWtState, setSlugGithubIssue, setSlugIssueId } from "../../core/wtstate.ts";
import { hasHelpFlag } from "../args.ts";
import { cyan, dim, green, red } from "../colors.ts";

const USAGE = `usage: wt issue <slug>              show the worktree's issue ids + urls
       wt issue <slug> --id <ID>    set the tracker id (overrides the slug)
       wt issue <slug> --clear-id   drop the override, back to the slug
       wt issue <slug> --gh <n>     attach GitHub issue #n as the secondary id
       wt issue <slug> --clear-gh   detach the secondary GitHub issue

<slug> also accepts a branch name. The primary id normally comes from the
slug (eng-1935-… → ENG-1935); --id supplies one when the slug carries none
(or carries the wrong one), and is what {{issue_id}} renders. Neither --id
nor --gh ever changes the branch.`;

export async function run(argv: string[]): Promise<number> {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const [first, ...rest] = argv;
  if (!first) {
    console.log(USAGE);
    return 2;
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

  if (rest[0] === "--id") {
    const raw = (rest[1] ?? "").trim();
    if (!raw) {
      console.error(red("--id requires an issue id (e.g. COZ-2185)"));
      return 2;
    }
    const id = raw.toUpperCase();
    // Validated here as well as in the TUI: this is the other door
    // into the same store, and a typo would render into {{issue_id}}
    // and move somebody else's ticket.
    if (!ISSUE_ID_RE.test(id)) {
      console.error(red(`not an issue id: ${raw} (expected e.g. COZ-2185)`));
      return 2;
    }
    setSlugIssueId(wt.slug, id);
    console.log(green(`✓ ${wt.slug} ← ${id}`));
    const url = issueUrlForId(id);
    if (url) console.log(`  ${dim(url)}`);
    return 0;
  }
  if (rest[0] === "--clear-id") {
    setSlugIssueId(wt.slug, null);
    // Say what it fell back TO: clearing an override on a slug that
    // parses is not the same as having no id, and the difference is
    // exactly what the next reader acts on.
    const back = issueIdForSlug(wt.slug);
    console.log(
      green(
        back
          ? `✓ ${wt.slug} tracker id override cleared — back to ${back} (from slug)`
          : `✓ ${wt.slug} tracker id cleared — the slug carries none`,
      ),
    );
    return 0;
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

  const slugState = readWtState().slugs[wt.slug];
  const stored = slugState?.issueId ?? null;
  const id = resolveIssueId(wt.slug, stored);
  const gh = slugState?.githubIssue ?? null;
  console.log(`${cyan(wt.slug)}`);
  // Name the SOURCE. "COZ-2185" alone cannot answer the question the
  // reader actually has here — whether clearing the override would
  // change anything — and that is the only reason to run this.
  const src = stored ? dim(" (set)") : id ? dim(" (from slug)") : "";
  console.log(
    `  ${dim("issue:")} ${id ?? dim("—")}${src}${id ? `  ${dim(issueUrlForId(id) ?? "")}` : ""}`,
  );
  console.log(
    `  ${dim("gh:")}    ${gh ? `#${gh}  ${dim(githubIssueUrl(gh) ?? "")}` : dim("—")}`,
  );
  return 0;
}
