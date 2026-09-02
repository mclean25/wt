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
import { Effect } from "effect";

import { createLogger } from "./logger.ts";
import { run } from "./proc.ts";

const log = createLogger("[notify]");

/**
 * One line, AppleScript-safe. JSON escaping covers quotes/backslashes
 * (AppleScript shares those escapes); control chars are stripped
 * OUTRIGHT first because JSON would emit `\uXXXX` for them, which
 * AppleScript does NOT parse — a stray control byte would otherwise
 * fail the whole osascript compile and silently drop the banner.
 */
function appleScriptString(s: string): string {
  return JSON.stringify(
    s
      .replaceAll(/\s+/g, " ")
      .replaceAll(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .trim(),
  );
}

export function notifyMacos(
  title: string,
  message: string,
): Effect.Effect<void> {
  if (process.platform !== "darwin") {
    return Effect.sync(() =>
      log.debug("skipping notification (not macOS)", { title }),
    );
  }
  const script = `display notification ${appleScriptString(message)} with title ${appleScriptString(title)}`;
  return run(["osascript", "-e", script]).pipe(
    Effect.tap((result) =>
      Effect.sync(() => {
        if (result.exitCode !== 0) {
          log.warn("osascript notification failed", {
            exitCode: result.exitCode,
            stderr: result.stderr.slice(0, 200),
          });
        }
      }),
    ),
    Effect.catch((error) =>
      Effect.sync(() =>
        log.warn("osascript notification failed", { error: error.message }),
      ),
    ),
    Effect.asVoid,
  );
}
