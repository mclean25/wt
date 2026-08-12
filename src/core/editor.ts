/**
 * Opening a checkout in an editor — `wt open`, the TUI's `o` / `O`, the
 * slot palettes' `z`, and `wt new --open`.
 *
 * Two paths, selected by `[editor] command`:
 *
 *   - **unset (default)** — the built-in Zed integration in `zed.ts`:
 *     focus-if-already-open via yabai, else `zed -n`, plus hiding the
 *     frontmost terminal. This is what wt did unconditionally before
 *     the section existed, so an existing config is unchanged.
 *   - **set** — `$SHELL -lc <command>` with `{{path}}` substituted. Any
 *     editor works; wt holds no window handle, so focus-if-open falls
 *     to the editor (every mainstream one raises a directory it already
 *     has open, which is why there's nothing to reimplement here).
 *
 * The terminal hide happens on both paths: it's about the terminal wt
 * is running in, not about which editor is being launched.
 */
import { spawn } from "node:child_process";

import { config } from "./config.ts";
import { hideFrontmostTerminal, openInZed } from "./zed.ts";

/** Single-quote for `$SHELL -lc` so a path with spaces or quotes can't break out. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the configured command for `path`. `{{path}}` substitutes
 * everywhere it appears; a command that never mentions it gets the path
 * appended, so a bare `cursor` behaves the way anyone would expect.
 */
export function renderEditorCommand(command: string, path: string): string {
  const quoted = shellQuote(path);
  return command.includes("{{path}}")
    ? command.replaceAll("{{path}}", quoted)
    : `${command} ${quoted}`;
}

/**
 * Open `path` in the configured editor. Resolves once the launch has
 * been attempted — short-lived CLI callers exit immediately afterwards,
 * so nothing may be left to a background tick.
 */
export async function openInEditor(path: string): Promise<void> {
  const command = config.editor.command;
  if (command === null) {
    await openInZed(path);
    return;
  }
  await hideFrontmostTerminal();
  const shell = process.env.SHELL || "bash";
  const child = spawn(shell, ["-lc", renderEditorCommand(command, path)], {
    stdio: "ignore",
    detached: true,
  });
  // An unhandled 'error' event is fatal to the whole process in
  // Node/Bun, so convert it into something the caller's catch can
  // report (same reasoning as `spawnZedAndTrack`).
  let spawnError: Error | null = null;
  child.once("error", (err) => {
    spawnError = err instanceof Error ? err : new Error(String(err));
  });
  child.unref();
  await new Promise((r) => setTimeout(r, 30));
  if (spawnError !== null) {
    throw new Error(`[editor] command failed to launch: ${(spawnError as Error).message}`);
  }
}
