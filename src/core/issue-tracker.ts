import { config } from "./config.ts";

// Input conveniences for `wt new`: a pasted URL or bare id resolves to
// a branch. Independent of `[issue_tracker]` — they parse *input*, not
// config. The URL shape is Linear's (the one tracker with a known
// paste-a-URL format); the bare-id shape matches any Linear/Jira/
// Shortcut/Cozee-style id (`ENG-1234`, `COZ-1953`).
export const ISSUE_URL_RE = /linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/i;
export const ISSUE_ID_RE = /^[A-Z]+-\d+$/i;

/** Issue id embedded in a worktree slug (`coz-1883-some-fix` → `coz-1883`). */
export const ISSUE_SLUG_ID_RE = /([a-z]+-\d+)(?:-|$)/i;

/**
 * Uppercased issue id parsed from a slug, or null when the slug carries
 * none. Independent of `[issue_tracker]` — parsing is free; config only
 * decides whether/where the id is displayed or linked.
 */
export function issueIdForSlug(slug: string): string | null {
  const m = ISSUE_SLUG_ID_RE.exec(slug);
  return m?.[1] ? m[1].toUpperCase() : null;
}

/**
 * A `GH-<n>` id refers to a GitHub issue on this repo — a built-in
 * convention, not a tracker prefix (GitHub has no team-id prefixes of
 * its own, so `gh-970` in a slug is unambiguous). It routes to the
 * origin repo's /issues/<n> instead of `url_template`.
 */
const GH_ID_RE = /^GH-(\d+)$/;

/**
 * Web URL for a git remote (`git@github.com:o/r.git`,
 * `https://github.com/o/r.git`, `ssh://git@github.com/o/r` →
 * `https://github.com/o/r`). Null when the shape isn't recognized —
 * bare host aliases (`work:o/r.git`) don't name a real host, so no URL
 * is derivable. Exported for tests.
 */
export function repoWebUrl(remote: string): string | null {
  const m =
    /^(?:git@|ssh:\/\/git@|https?:\/\/)([^/:]+\.[^/:]+)[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  return m ? `https://${m[1]}/${m[2]}/${m[3]}` : null;
}

/** Memoized origin-remote web URL of the main clone (null = underivable). */
let _mainRepoWebUrl: string | null | undefined;
function mainRepoWebUrl(): string | null {
  if (_mainRepoWebUrl === undefined) {
    const r = Bun.spawnSync(
      ["git", "-C", config.paths.mainClone, "remote", "get-url", "origin"],
    );
    _mainRepoWebUrl =
      r.exitCode === 0 ? repoWebUrl(r.stdout.toString()) : null;
  }
  return _mainRepoWebUrl;
}

/**
 * Deep link for the slug's issue id. `GH-<n>` ids link to the origin
 * repo's GitHub issue; everything else goes through
 * `[issue_tracker].url_template` (or the `[issue_tracker.linear]`
 * preset). Null when no link is derivable or the slug has no id.
 */
export function issueUrlForSlug(slug: string): string | null {
  const id = issueIdForSlug(slug);
  if (!id) return null;
  const gh = GH_ID_RE.exec(id);
  if (gh) {
    const repo = mainRepoWebUrl();
    return repo ? `${repo}/issues/${gh[1]}` : null;
  }
  const template = config.issueTracker?.urlTemplate;
  if (!template) return null;
  return template.replaceAll("{id}", id);
}
