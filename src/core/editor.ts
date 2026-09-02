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
import { Data, Effect } from "effect";

import { config } from "./config.ts";
import { causeMessage } from "./errors.ts";
import { hideFrontmostTerminal, openInZed } from "./zed.ts";

export class EditorLaunchError extends Data.TaggedError("EditorLaunchError")<{
  readonly command: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `${this.command}: ${causeMessage(this.cause)}`;
  }
}

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
function spawnDetached(
  shell: string,
  command: string,
): Effect.Effect<void, EditorLaunchError> {
  return Effect.callback<void, EditorLaunchError>((resume) => {
    let child: ReturnType<typeof spawn>;
    let settled = false;
    try {
      child = spawn(shell, ["-lc", command], {
        stdio: "ignore",
        detached: true,
      });
    } catch (cause) {
      resume(Effect.fail(new EditorLaunchError({ command, cause })));
      return;
    }
    const onSpawn = () => {
      settled = true;
      child.unref();
      resume(Effect.void);
    };
    const onError = (cause: unknown) => {
      settled = true;
      resume(Effect.fail(new EditorLaunchError({ command, cause })));
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
    return Effect.sync(() => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      if (!settled) child.kill();
    });
  });
}

export function openInEditor(
  path: string,
): Effect.Effect<void, EditorLaunchError> {
  const command = config.editor.command;
  if (command === null) {
    return openInZed(path).pipe(
      Effect.mapError((cause) =>
        new EditorLaunchError({ command: `zed -n ${path}`, cause }),
      ),
    );
  }
  const shell = process.env.SHELL || "bash";
  const rendered = renderEditorCommand(command, path);
  return hideFrontmostTerminal().pipe(
    Effect.andThen(spawnDetached(shell, rendered)),
  );
}

/** Promise adapter for CLI and React event boundaries. */
export function openInEditorPromise(path: string): Promise<void> {
  return Effect.runPromise(openInEditor(path));
}
