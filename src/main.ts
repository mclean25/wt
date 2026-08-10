#!/usr/bin/env bun

// Make `Bun.stringWidth` treat East-Asian-Ambiguous codepoints as 2-cell
// before any opentui code loads. Our patched Lilex Nerd Font sets the
// advance for every PUA icon to 2 mono cells; opentui's text layout
// calls `Bun.stringWidth` with default options (which counts PUA as 1)
// and ends up shoving subsequent text into the icon's right half. The
// override aligns opentui's count with what the terminal actually
// renders, so spans, columns, and right-pinned clusters line up.
const _origStringWidth = Bun.stringWidth;
Bun.stringWidth = ((s: string, opts?: Bun.StringWidthOptions) =>
  _origStringWidth(s, { ...(opts ?? {}), ambiguousIsNarrow: false })) as typeof Bun.stringWidth;

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  // Args given → dispatch to CLI. The self-update family routes AROUND
  // cli/index.ts: that module statically imports every command, which
  // pulls the fail-fast config loader in before dispatch — and these
  // commands must work when the config is exactly what a broken update
  // can't load (`wt rollback` is the documented recovery path then).
  if (argv.length > 0) {
    const [cmd, ...rest] = argv;
    if (cmd === "update") return (await import("./cli/commands/update.ts")).run(rest);
    if (cmd === "rollback") return (await import("./cli/commands/rollback.ts")).run(rest);
    if (cmd === "version" || cmd === "--version" || cmd === "-v") {
      return (await import("./cli/commands/version.ts")).run(rest);
    }
    const { dispatch } = await import("./cli/index.ts");
    return dispatch(argv);
  }

  // No args + non-TTY → fall back to `ls` (matches the old Python tool's
  // behavior for piped/scripted use).
  if (!process.stdout.isTTY) {
    const { dispatch } = await import("./cli/index.ts");
    return dispatch(["ls"]);
  }

  // No args + TTY → interactive TUI. Every user action runs in-TUI now
  // (no CLI handoff for `new` or `clean`), so this is a single call.
  const { config } = await import("./core/config.ts");
  // Skills/instructions freshness check BEFORE the TUI takes the
  // terminal, so accepted updates are live for every agent session
  // spawned from this run. Silent when nothing is pending.
  if (config.skills.startupCheck) {
    const { startupSkillsPrompt } = await import("./cli/skills-sync.ts");
    await startupSkillsPrompt();
  }
  // Self-update check, after skills (both prompt on this terminal).
  // An accepted pull re-execs a fresh process instead of continuing:
  // main.ts/config.ts are already loaded from the old code, and lazy
  // TUI imports would come from the new checkout — never run the mix.
  // WT_UPDATE=off is the per-run kill switch (probe harness arms it).
  if (config.update.startupCheck && process.env.WT_UPDATE !== "off") {
    const { startupUpdatePrompt } = await import("./cli/commands/update.ts");
    if ((await startupUpdatePrompt()) === "updated") {
      const { spawnFreshWt } = await import("./core/update.ts");
      return spawnFreshWt();
    }
  }
  // Boot sentinel: record that this version is starting; core/update
  // promotes it to "known good" once it survives the health window (or
  // exits cleanly). A leftover sentinel on the next launch is evidence
  // the previous start died without tripping the catch below (native
  // crash, kill) — offer a rollback before trying again. Runs after
  // the update prompt so a just-landed fix wins over rolling back.
  if (process.env.WT_UPDATE !== "off") {
    const { maybeOfferStaleBootRollback } = await import("./cli/commands/rollback.ts");
    await maybeOfferStaleBootRollback();
    const { armBootSentinel } = await import("./core/update.ts");
    armBootSentinel();
  }
  const { setWezTermTabTitle } = await import("./core/wezterm.ts");
  await setWezTermTabTitle("wt", config.paths.weztermCli);
  const { runTui } = await import("./tui/runtime.tsx");
  await runTui();
  if (process.env.WT_UPDATE !== "off") {
    const { completeBootSentinel } = await import("./core/update.ts");
    completeBootSentinel();
  }
  return 0;
}

try {
  const code = await main();
  // Explicit exit: the TUI path can leave behind background listeners
  // (persister sub, refetch intervals, sqlite handle) that keep the
  // event loop alive even after cleanup. A hard exit is the standard
  // CLI pattern here.
  process.exit(code);
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  // If this version is a fresh update that never booted healthy, offer
  // to roll back to the one that did. The offer path is config-free
  // (core/update.ts) so it works even when the crash IS the config
  // loader rejecting the user's config; it re-execs on acceptance and
  // must never mask the original error otherwise.
  try {
    const { maybeOfferCrashRollback } = await import("./cli/commands/rollback.ts");
    await maybeOfferCrashRollback();
  } catch {
    // Nothing — the crash above is the story.
  }
  process.exit(1);
}
