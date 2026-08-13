/**
 * Compatibility no-op for Claude sessions started before wt's message
 * transport changed.
 *
 * wt used to launch every session with `--settings` carrying
 * SessionStart/SessionEnd hooks that ran `<checkout>/bin/wt
 * _claude-hook register|unregister` to capture Claude's own messaging
 * socket address. That whole mechanism is gone — messages now arrive by
 * prompt injection, which needs nothing from the session's settings.
 *
 * But those hooks are baked into every ALREADY-RUNNING session's launch
 * flags, and wt self-updates hot in the same checkout: the moment the
 * user pulls, that absolute path resolves to a binary where the
 * subcommand no longer exists, so the next SessionEnd prints "unknown
 * command" plus the whole help block into a hook the session surfaces.
 * Every long-lived session would do it, once, on exit — a guaranteed
 * visible regression for doing nothing wrong.
 *
 * So it stays, silent and successful, until those sessions have turned
 * over. Deletable once no session predating the transport change can
 * still be running.
 */
export async function run(_argv: string[]): Promise<number> {
  return 0;
}
