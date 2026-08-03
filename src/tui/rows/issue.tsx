import { config } from "../../core/config.ts";
import { issueIdForSlug, issueUrlForSlug } from "../../core/issue-tracker.ts";
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
    const url = issueUrlForSlug(row.wt.slug);
    if (url) {
      return (
        <text fg={theme.accentAlt} wrapMode="none" truncate>
          {url}
        </text>
      );
    }
    const id = issueIdForSlug(row.wt.slug);
    return id ? (
      <text fg={theme.fg} wrapMode="none" truncate>
        {id}
      </text>
    ) : (
      <text fg={theme.fgDim}>—</text>
    );
  },
};
