/**
 * The manager session's shared identity constants.
 *
 * The manager runs in the MAIN CLONE's directory (so `gh`, repo
 * context, and `wt status --all` work), which is the same cwd as the
 * `.` main-clone slot. Claude's primary-conversation UUID is derived
 * from the cwd alone, so two "primary" sessions in one directory are
 * literally ONE conversation — the manager therefore lives as a NAMED
 * claude session (`manager~manager` in tmux, its own deterministic
 * UUID from `wtSessionUuid(mainClone, "manager")`). Every path that
 * addresses the manager (the TUI `m` key, `wt manager [send]`,
 * `[[actions]]` with `target = "manager"`, automations briefings)
 * must pass `MANAGER_CLAUDE_NAME` as the managed name — import from
 * here, never restate the strings.
 *
 * Codex / OpenCode ignore managed names for tmux naming (single slot
 * per slug), so passing it unconditionally is harmless there.
 */
import { addClaudeName } from "./harness/claude/names.ts";

export const MANAGER_SLUG = "manager";
export const MANAGER_CLAUDE_NAME = "manager";

/**
 * Persist the manager's claude name so session discovery
 * (`claudeStatus` → `listClaudeNames`) sees the named conversation —
 * the footer's `[m]` state and the resume-vs-create gate both depend
 * on it. Idempotent; call before any manager addressing.
 */
export function ensureManagerClaudeName(): void {
  addClaudeName(MANAGER_SLUG, MANAGER_CLAUDE_NAME);
}
