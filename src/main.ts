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

  // Args given → dispatch to CLI.
  if (argv.length > 0) {
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
      const { WT_REPO_ROOT } = await import("./core/update.ts");
      const { join } = await import("node:path");
      const child = Bun.spawnSync({
        cmd: [process.execPath, join(WT_REPO_ROOT, "src", "main.ts")],
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return child.exitCode ?? 1;
    }
  }
  // Boot sentinel: record that this version is starting; promote it to
  // "known good" once it survives BOOT_HEALTHY_MS (or exits cleanly
  // before that). A leftover sentinel on the next launch is evidence
  // the previous start died without tripping the catch below (native
  // crash, kill) — offer a rollback before trying again. Runs after
  // the update prompt so a just-landed fix wins over rolling back.
  if (process.env.WT_UPDATE !== "off") {
    const { maybeOfferStaleBootRollback } = await import("./cli/commands/rollback.ts");
    await maybeOfferStaleBootRollback();
    const { gitSync, markBooting, markBootGood } = await import("./core/update.ts");
    const head = gitSync(["rev-parse", "HEAD"]);
    if (head) {
      const BOOT_HEALTHY_MS = 15_000;
      markBooting(head, Date.now());
      setTimeout(() => markBootGood(head), BOOT_HEALTHY_MS);
    }
  }
  const { setWezTermTabTitle } = await import("./core/wezterm.ts");
  await setWezTermTabTitle("wt", config.paths.weztermCli);
  const { runTui } = await import("./tui/runtime.tsx");
  await runTui();
  // A clean quit before the health timer counts as a healthy boot too.
  if (process.env.WT_UPDATE !== "off") {
    const { gitSync, markBootGood } = await import("./core/update.ts");
    const head = gitSync(["rev-parse", "HEAD"]);
    if (head) markBootGood(head);
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
