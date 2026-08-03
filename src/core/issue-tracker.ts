import { config } from "./config.ts";

// Input conveniences for `wt new`: a pasted URL or bare id resolves to
// a branch. Independent of `[issue_tracker]` — they parse *input*, not
// config. Only the URL pattern is actually Linear-specific; the bare-id
// shape matches any Linear/Jira/Shortcut-style id (the names keep the
// LINEAR_ prefix for continuity with their `wt new` docs).
export const LINEAR_URL_RE = /linear\.app\/[^/]+\/issue\/([A-Z]+-\d+)/i;
export const LINEAR_ID_RE = /^[A-Z]+-\d+$/i;

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
 * Deep link for the slug's issue id via `[issue_tracker].url_template`
 * (or the `[issue_tracker.linear]` preset). Null when no template is
 * configured or the slug has no id.
 */
export function issueUrlForSlug(slug: string): string | null {
  const template = config.issueTracker?.urlTemplate;
  if (!template) return null;
  const id = issueIdForSlug(slug);
  if (!id) return null;
  return template.replaceAll("{id}", id);
}
