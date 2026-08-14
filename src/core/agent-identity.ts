/**
 * Who is running this wt command — the agent identity wt stamps on
 * every harness session it launches (`WT_AGENT`, set by
 * `tmux/inner-process.ts`): a worktree slug, or `manager` for the
 * singleton coordinator. Absent everywhere else, which is correct — the
 * TUI and a human's shell are not agents, and `wrapInnerArgs` unsets the
 * variable rather than letting a human's `F10` shell inherit the slug of
 * whoever launched wt.
 *
 * A leaf module on purpose. Both consumers are attribution paths that
 * must not drag machinery in with them: `wt manager send` stamps
 * outgoing fleet mail, and `wt status` records who asserted a work
 * status — the command an agent uses to say it is stuck, which has to
 * keep working when the session layer is what broke.
 *
 * It is an attribution aid, not a credential: anything inside a session
 * can set it, and everything reading it already trusts the session.
 */
export function agentIdentity(): string | null {
  const agent = (process.env.WT_AGENT ?? "").trim();
  return agent.length > 0 ? agent : null;
}
