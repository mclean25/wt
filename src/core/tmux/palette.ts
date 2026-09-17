import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";

import { operationErrors } from "../errors.ts";
import { run } from "../proc.ts";
import { TMUX_SOCKET } from "./naming.ts";
import { tmuxServerDefinitelyAbsent } from "./process.ts";

const io = operationErrors("tmux palette");
const filename = "terminal-palette.json";

export interface TerminalPalette {
  readonly defaultForeground: string;
  readonly defaultBackground: string;
}

/** Only observed RGB defaults are useful. Never guess a theme on timeout. */
export function terminalPalette(value: unknown): TerminalPalette | null {
  if (!value || typeof value !== "object") return null;
  const colors = value as Partial<TerminalPalette>;
  if (typeof colors.defaultForeground !== "string" || typeof colors.defaultBackground !== "string") return null;
  if (!/^#[0-9a-f]{6}$/i.test(colors.defaultForeground) || !/^#[0-9a-f]{6}$/i.test(colors.defaultBackground)) return null;
  return {
    defaultForeground: colors.defaultForeground.toLowerCase(),
    defaultBackground: colors.defaultBackground.toLowerCase(),
  };
}

function style(colors: TerminalPalette): string {
  return `fg=${colors.defaultForeground},bg=${colors.defaultBackground}`;
}

/** Global defaults leave explicit per-window and per-pane styles alone. */
export function terminalPaletteConfig(value: unknown): string {
  const colors = terminalPalette(value);
  if (!colors) return "";
  return `set -g window-style '${style(colors)}'\nset -g window-active-style '${style(colors)}'\n`;
}

/** Synchronous adapter for the existing synchronous tmux config writer. */
export function readTerminalPaletteConfig(cacheRoot: string): string {
  try {
    return terminalPaletteConfig(JSON.parse(readFileSync(join(cacheRoot, filename), "utf8")));
  } catch {
    // Optional cache: corrupt/missing observations do not invent terminal colors.
    return "";
  }
}

export const saveTerminalPalette = Effect.fn("saveTerminalPalette")(function* (cacheRoot: string, value: unknown) {
  const colors = terminalPalette(value);
  if (!colors) return false;
  yield* io.sync("save observed terminal palette", () => {
    mkdirSync(cacheRoot, { recursive: true });
    const target = join(cacheRoot, filename);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(colors), { mode: 0o600 });
      renameSync(temporary, target);
    } finally {
      try { unlinkSync(temporary); } catch { /* renamed or never created */ }
    }
  });
  return true;
});

export const applyTerminalPalette = Effect.fn("applyTerminalPalette")(function* (value: unknown) {
  const colors = terminalPalette(value);
  if (!colors) return false;
  // set-option never starts a server; detached cold starts use the persisted config.
  const result = yield* run([
    "tmux", "-L", TMUX_SOCKET,
    "set-option", "-g", "window-style", style(colors), ";",
    "set-option", "-g", "window-active-style", style(colors),
  ], { timeoutMs: 1000 }).pipe(Effect.timeout("2 seconds"));
  if (result.exitCode !== 0) {
    if (tmuxServerDefinitelyAbsent(result.stderr)) return false;
    return yield* io.wrap("apply observed terminal palette")(result.stderr || `tmux exited ${result.exitCode}`);
  }
  return true;
});
