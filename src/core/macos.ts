/**
 * macOS-only process utilities (`open`, `pbcopy`) — part of the macOS
 * assumption noted in the README.
 */
import { Data, Effect } from "effect";

import { hideFrontmostTerminalEffect } from "./zed.ts";
import { config } from "./config.ts";
import { runEffect } from "./proc.ts";

export class MacosCommandError extends Data.TaggedError("MacosCommandError")<{
  readonly operation: "open" | "pbcopy";
  readonly cause: unknown;
}> {}

/**
 * Build the macOS launcher command for a URL. A configured Chrome profile
 * applies only to web URLs: custom schemes such as `linear://` still need
 * Launch Services to route them to their owning application.
 */
export function openUrlCommand(
  url: string,
  chromeProfile = config.browser.chromeProfile,
): string[] {
  if (chromeProfile && /^https?:\/\//i.test(url)) {
    return [
      "open",
      "-a",
      "Google Chrome",
      "--args",
      `--profile-directory=${chromeProfile}`,
      "--ignore-profile-directory-if-not-exists",
      url,
    ];
  }
  return ["open", url];
}

/** Fire-and-forget `open <url>`. The macOS `open` binary returns immediately. */
export function openUrl(url: string): void {
  Effect.runFork(openUrlEffect(url).pipe(Effect.catch(() => Effect.void)));
}

export function openUrlEffect(url: string): Effect.Effect<void, MacosCommandError> {
  return runEffect(openUrlCommand(url)).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new MacosCommandError({
              operation: "open",
              cause: result.stderr || `exit ${result.exitCode}`,
            }),
          ),
    ),
    Effect.mapError((cause) =>
      cause instanceof MacosCommandError
        ? cause
        : new MacosCommandError({ operation: "open", cause }),
    ),
  );
}

/**
 * Hide a frontmost terminal window, *then* open the URL. Order matters:
 * `openUrl` brings the browser to the front, while `hideFrontmostTerminal`
 * shells out to `osascript` to sample the frontmost app and only sends
 * Cmd+H if it's a supported terminal (Alacritty or WezTerm). Firing both
 * without awaiting lets the browser win the race — the frontmost query
 * then sees the browser, not the terminal, and the hide no-ops. Awaiting
 * the hide first keeps the terminal frontmost long enough to be detected
 * and hidden. (Matters since the hide became async; `openInZed` already
 * sequences its own hide internally.)
 */
export function openUrlHidingTerminalEffect(
  url: string,
): Effect.Effect<void, MacosCommandError> {
  return hideFrontmostTerminalEffect().pipe(
    Effect.andThen(openUrlEffect(url)),
  );
}

export function openUrlHidingTerminal(url: string): Promise<void> {
  return Effect.runPromise(
    openUrlHidingTerminalEffect(url).pipe(Effect.catch(() => Effect.void)),
  );
}

/** Write to the macOS clipboard via pbcopy. Fire-and-forget. */
export function writeClipboard(text: string): void {
  Effect.runFork(
    writeClipboardEffect(text).pipe(Effect.catch(() => Effect.void)),
  );
}

export function writeClipboardEffect(
  text: string,
): Effect.Effect<void, MacosCommandError> {
  return runEffect(["pbcopy"], { input: text }).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.void
        : Effect.fail(
            new MacosCommandError({
              operation: "pbcopy",
              cause: result.stderr || `exit ${result.exitCode}`,
            }),
          ),
    ),
    Effect.mapError((cause) =>
      cause instanceof MacosCommandError
        ? cause
        : new MacosCommandError({ operation: "pbcopy", cause }),
    ),
  );
}
