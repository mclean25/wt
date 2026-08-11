import { injectIntoSession, type InjectResult } from "../tmux/inject.ts";
import { claudeSessions, type ClaudeSendResult } from "./claude/sessions.ts";
import type { HarnessId } from "./types.ts";

export type SessionMessageResult = InjectResult | ClaudeSendResult;

/**
 * Deliver a prompt to a live harness conversation, cold-starting its tmux
 * host when needed. Claude always uses its native Unix socket; only the other
 * harnesses retain terminal injection.
 */
export async function sendSessionMessage(opts: {
  slug: string;
  cwd: string;
  harnessId: HarnessId;
  managedName?: string | null;
  text: string;
}): Promise<SessionMessageResult> {
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
