/**
 * macOS user notifications — the out-of-band leg of the escalation
 * ladder (dot → attention feed → this). One shape today: an `osascript
 * display notification` banner, used by the `builtin:notify` automation
 * so `[[automations]]` semantics (level + ledger dedupe, breaker,
 * pause) come free instead of being reimplemented here.
 *
 * macOS-only by the same assumption the rest of wt makes (`open`,
 * `pbcopy`, launchd — see README). Fire-and-forget: a failed banner is
 * never worth surfacing as an error, the attention feed already
 * carries the signal.
 */
import { createLogger } from "./logger.ts";
import { run } from "./proc.ts";

const log = createLogger("[notify]");

/** One line, AppleScript-safe: JSON escaping covers quotes/backslashes. */
function appleScriptString(s: string): string {
  return JSON.stringify(s.replaceAll(/\s+/g, " ").trim());
}

export async function notifyMacos(title: string, message: string): Promise<void> {
  if (process.platform !== "darwin") {
    log.debug("skipping notification (not macOS)", { title });
    return;
  }
  const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
  const result = await run(["osascript", "-e", script]);
  if (result.exitCode !== 0) {
    log.warn("osascript notification failed", {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 200),
    });
  }
}
