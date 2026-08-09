/**
 * Shared argv helpers for CLI subcommands. Every subcommand under
 * `src/cli/commands/` used to reimplement `--help`/`-h` detection
 * ad-hoc (some checked only the first positional, several didn't check
 * at all — `wt rm --help` fell through to "unknown flag"). This module
 * is the one place that logic lives now.
 */

/** True if `--help`/`-h` appears anywhere in argv. Check this FIRST, before any flag/positional parsing, so help always wins regardless of position. */
export function hasHelpFlag(argv: readonly string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

/**
 * First `-`-prefixed token not in `known` — for commands whose flags
 * are all valueless/boolean, one call rejects typos (`--jsno`) instead
 * of silently ignoring them. Not suited to flags that consume a
 * following value (`--slug <s>`) since the value itself may start with
 * `-`; those commands keep their own hand-rolled loop and inline check.
 */
export function firstUnknownFlag(
  argv: readonly string[],
  known: ReadonlySet<string>,
): string | null {
  for (const a of argv) {
    if (a.startsWith("-") && a !== "-" && !known.has(a)) return a;
  }
  return null;
}
