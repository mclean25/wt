import { config } from "../../core/config.ts";
import { issueUrlForId, resolveIssueId } from "../../core/issue-tracker.ts";
import { theme } from "../theme.ts";
import type { RowModule } from "./types.ts";

export const issueRow: RowModule = {
  id: "issue",
  label: "issue",
  // No [issue_tracker] section = no issue-tracker concept. Hide the row
  // rather than render a permanent "—". The section alone (no
  // url_template) shows the bare parsed id; a template links it.
  visible: () => config.issueTracker !== null,
  render: ({ row }) => {
    // Primary identity first, secondary GitHub issue after — display
    // reads the primary; the `i` action targets the most specific.
    const gh = row.githubIssue ? ` · #${row.githubIssue}` : "";
    const id = resolveIssueId(row.wt.slug, row.issueId);
    const url = issueUrlForId(id);
    if (url) {
      return (
        <text wrapMode="none" truncate>
          <span fg={theme.accentAlt}>{url}</span>
          {gh ? <span fg={theme.fg}>{gh}</span> : null}
        </text>
      );
    }
    return id || gh ? (
      <text fg={theme.fg} wrapMode="none" truncate>
        {`${id ?? "—"}${gh}`}
      </text>
    ) : (
      <text fg={theme.fgDim}>—</text>
    );
  },
};
