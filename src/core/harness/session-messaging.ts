import {
  injectIntoSession,
  injectSlashCommand,
  type InjectResult,
} from "../tmux/inject.ts";
import { claudeSessions, type ClaudeSendResult } from "./claude/sessions.ts";
import type { HarnessId } from "./types.ts";

export type SessionMessageResult = InjectResult | ClaudeSendResult;

/**
 * Whether a payload is a slash command rather than a message — i.e.
 * whether it only means anything if the harness *executes* it.
 *
 * Anchored and shaped, not a bare `startsWith("/")`: a command name is
 * lowercase and unbroken, and must be the whole first token. That is
 * what keeps a message opening with an absolute path out of the command
 * path — `/Users/…` fails the lowercase rule and `/tmp/foo` fails the
 * token boundary, while `/compact` and `/compact <args>` match.
 */
export function isSlashCommand(text: string): boolean {
  return /^\/[a-z][a-z0-9_-]*(\s|$)/.test(text.trimStart());
}

/**
 * Deliver a prompt to a live harness conversation, cold-starting its tmux
 * host when needed. Claude uses its native Unix socket; only the other
 * harnesses retain terminal injection for ordinary messages.
 *
 * The exception is a slash command. The socket carries a *message*, and
 * the receiver frames peer messages as quoted text, so `/compact` sent
 * that way arrives as a paragraph about compaction and nothing happens —
 * silently, since the message itself does land and delivery confirms.
 * Commands therefore go through the pane, where a submit is a submit.
 * Keep the branch here rather than at the call sites: every session-
 * delivery path in wt funnels through this function, and a second
 * transport rule maintained in more than one place is a transport rule
 * that will disagree with itself.
 */
export async function sendSessionMessage(opts: {
  slug: string;
  cwd: string;
  harnessId: HarnessId;
  managedName?: string | null;
  text: string;
}): Promise<SessionMessageResult> {
  if (isSlashCommand(opts.text)) {
    return await injectSlashCommand({ ...opts, harnessId: opts.harnessId });
  }
  if (opts.harnessId === "claude") {
    return await claudeSessions.send(
      {
        slug: opts.slug,
        cwd: opts.cwd,
        managedName: opts.managedName ?? null,
      },
      opts.text,
    );
  }
  return await injectIntoSession({ ...opts, harnessId: opts.harnessId });
}
