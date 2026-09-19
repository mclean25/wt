import { Effect } from "effect";

import { run } from "./proc.ts";
import { config } from "./config.ts";

import {
  findZedWindowForPath,
  focusYabaiWindow,
  spawnZedAndTrack,
  type ZedWindowError,
} from "./zed-windows.ts";

/**
 * If the frontmost app is opted in via ui.hide_terminal_apps,
 * hide it — same visual effect as Cmd+H. No-op from other terminals or
 * apps. Best-effort; any error (missing osascript, no automation perms,
 * sandboxed terminal) is swallowed because this is purely cosmetic UX.
 *
 * Hides via a process-property write (`set visible ... to false`) rather
 * than a synthetic Cmd+H keystroke. Sending keystrokes needs the stricter
 * Accessibility TCC permission, which a macOS or terminal update can
 * silently reset — leaving the frontmost read working (that only needs
 * Automation) while the keystroke fails with "not allowed to send
 * keystrokes (1002)", which the catch swallowed, so the hide quietly
 * no-oped. Setting `visible` needs only Automation, the same bucket the
 * frontmost query already relies on, so the two can't drift apart.
 *
 * One osascript call does both the frontmost check and the hide, closing
 * the window where focus could change between two separate invocations.
 * `ignoring case` covers osascript returning the marketing-name
 * capitalization for these terminals. WezTerm shows up as `wezterm-gui`
 * (its actual process name) rather than `WezTerm`; configure process names.
 */
export function hideTerminalCommand(apps: readonly string[]): string[] | null {
  if (apps.length === 0) return null;
  return [
      "osascript",
      "-e", "on run terminalApps",
      "-e", 'tell application "System Events"',
      "-e", "set p to first application process whose frontmost is true",
      "-e", "ignoring case",
      "-e",
      'if name of p is in terminalApps then set visible of p to false',
      "-e", "end ignoring",
      "-e", "end tell",
      "-e", "end run",
      "--", ...apps,
    ];
}

export const hideFrontmostTerminal = Effect.fn("hideFrontmostTerminal")(function* () {
  const command = hideTerminalCommand(config.ui.hideTerminalApps);
  if (command === null) return;
  yield* run(command).pipe(
      Effect.catch(() => Effect.void),
      Effect.asVoid,
    );
});

/**
 * Open `path` in Zed using focus-if-open, else-new-window semantics.
 * Zed 0.20x made `zed <path>` reuse the current window regardless of
 * whether another window already has the path open, so we track each
 * spawn's yabai window id in `~/.cache/wt/zed-windows.json` and focus
 * via yabai when one exists. Unified helper — both CLI and TUI call
 * this so behavior stays in sync.
 *
 * Returns after the spawn is either focused or tracking has been
 * recorded. Awaiting matters for short-lived CLI callers: the parent
 * exits right after and a background tracking poll wouldn't survive
 * `process.exit`.
 */
export const openInZed = Effect.fn("openInZed")(function* (
  path: string,
): Effect.fn.Return<void, ZedWindowError> {
  yield* hideFrontmostTerminal();
  const existing = yield* findZedWindowForPath(path);
  if (existing !== null && (yield* focusYabaiWindow(existing))) return;
  yield* spawnZedAndTrack(path);
});
