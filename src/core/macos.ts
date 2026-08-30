/**
 * macOS-only process utilities (`open`, `pbcopy`) — part of the macOS
 * assumption noted in the README.
 */
import { hideFrontmostTerminal } from "./zed.ts";
import { config } from "./config.ts";

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
  Bun.spawn(openUrlCommand(url), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
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
export async function openUrlHidingTerminal(url: string): Promise<void> {
  await hideFrontmostTerminal();
  openUrl(url);
}

/** Write to the macOS clipboard via pbcopy. Fire-and-forget. */
export function writeClipboard(text: string): void {
  const proc = Bun.spawn(["pbcopy"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  if (!proc.stdin) return;
  proc.stdin.write(text);
  proc.stdin.end();
}
