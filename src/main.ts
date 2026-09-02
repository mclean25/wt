#!/usr/bin/env bun

import { Cause, Data, Effect } from "effect";

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

class MainStepError extends Data.TaggedError("MainStepError")<{
  readonly step: string;
  readonly cause: unknown;
}> {}

function step<A>(name: string, run: () => Promise<A>): Effect.Effect<A, MainStepError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => new MainStepError({ step: name, cause }),
  });
}

function commandStep(
  name: string,
  run: () => Effect.Effect<number, Error>,
): Effect.Effect<number, MainStepError> {
  return Effect.suspend(() => {
    let result: Effect.Effect<number, Error>;
    try {
      result = run();
    } catch (cause) {
      return Effect.fail(new MainStepError({ step: name, cause }));
    }
    return result.pipe(
      Effect.mapError((cause) => new MainStepError({ step: name, cause })),
    );
  });
}

function reportedCause(value: unknown): unknown {
  let current = value;
  while (
    current !== null &&
    typeof current === "object" &&
    "_tag" in current &&
    "cause" in current
  ) {
    const next = current.cause;
    if (next === current) break;
    current = next;
  }
  return current;
}

function mainEffect() {
  const argv = process.argv.slice(2);

  return Effect.gen(function* () {
    // Args given → dispatch to CLI. The self-update family routes AROUND
    // cli/index.ts even though that module now imports commands lazily:
    // these three must work when a bad update broke *anything* else, and
    // the dispatcher itself is one more module that can fail to parse
    // (`wt rollback` is the documented recovery path then).
    if (argv.length > 0) {
      const [cmd, ...rest] = argv;
      if (cmd === "update") {
        const command = yield* step("load update command", () =>
          import("./cli/commands/update.ts"),
        );
        return yield* commandStep("run update command", () => command.run(rest));
      }
      if (cmd === "rollback") {
        const command = yield* step("load rollback command", () =>
          import("./cli/commands/rollback.ts"),
        );
        return yield* commandStep("run rollback command", () => command.run(rest));
      }
      if (cmd === "version" || cmd === "--version" || cmd === "-v") {
        const command = yield* step("load version command", () =>
          import("./cli/commands/version.ts"),
        );
        return yield* commandStep("run version command", () => command.run(rest));
      }
      const { dispatchEffect } = yield* step("load CLI dispatcher", () => import("./cli/index.ts"));
      return yield* dispatchEffect(argv).pipe(
        Effect.mapError((cause) => new MainStepError({ step: "dispatch CLI", cause })),
      );
    }

    // No args + non-TTY → fall back to `ls` (matches the old Python tool's
    // behavior for piped/scripted use).
    if (!process.stdout.isTTY) {
      const { dispatchEffect } = yield* step("load CLI dispatcher", () => import("./cli/index.ts"));
      return yield* dispatchEffect(["ls"]).pipe(
        Effect.mapError((cause) => new MainStepError({ step: "dispatch ls", cause })),
      );
    }

    // No args + TTY → interactive TUI. Every user action runs in-TUI now
    // (no CLI handoff for `new` or `clean`), so this is a single call.
    const { config } = yield* step("load config", () => import("./core/config.ts"));
    if (config.instance.role === "worker") {
      yield* Effect.sync(() => console.error("wt TUI is disabled in worker mode; launch it on the controller"));
      return 2;
    }
  // Skills/instructions freshness check BEFORE the TUI takes the
  // terminal, so accepted updates are live for every agent session
  // spawned from this run. Silent when nothing is pending.
  // WT_SKILLS=off is the per-run kill switch (probe harness arms it —
  // a probe stuck on this y/n has no safe answer: both are remembered
  // in machine-global skills memory and would consume the human's own
  // prompt for that version).
    if (config.skills.startupCheck && process.env.WT_SKILLS !== "off") {
      const { startupSkillsPromptEffect } = yield* step("load skills startup check", () => import("./cli/skills-sync.ts"));
      yield* startupSkillsPromptEffect().pipe(
        Effect.mapError((cause) => new MainStepError({ step: "run skills startup check", cause })),
      );
    }
  // Self-update check, after skills (both prompt on this terminal).
  // An accepted pull re-execs a fresh process instead of continuing:
  // main.ts/config.ts are already loaded from the old code, and lazy
  // TUI imports would come from the new checkout — never run the mix.
  // WT_UPDATE=off is the per-run kill switch (probe harness arms it).
    if (config.update.startupCheck && process.env.WT_UPDATE !== "off") {
      const { startupUpdatePromptEffect } = yield* step("load update startup check", () => import("./cli/commands/update.ts"));
      if ((yield* startupUpdatePromptEffect().pipe(
        Effect.mapError((cause) => new MainStepError({ step: "run update startup check", cause })),
      )) === "updated") {
        const { spawnFreshWt } = yield* step("load fresh wt launcher", () => import("./core/update.ts"));
        return yield* Effect.sync(spawnFreshWt);
      }
    }
  // Boot sentinel: record that this version is starting; core/update
  // promotes it to "known good" once it survives the health window (or
  // exits cleanly). A leftover sentinel on the next launch is evidence
  // the previous start died without tripping the catch below (native
  // crash, kill) — offer a rollback before trying again. Runs after
  // the update prompt so a just-landed fix wins over rolling back.
    if (process.env.WT_UPDATE !== "off") {
      const { maybeOfferStaleBootRollbackEffect } = yield* step("load stale boot rollback", () => import("./cli/commands/rollback.ts"));
      yield* maybeOfferStaleBootRollbackEffect().pipe(
        Effect.mapError((cause) => new MainStepError({ step: "run stale boot rollback", cause })),
      );
      const { armBootSentinelEffect } = yield* step("load boot sentinel", () => import("./core/update.ts"));
      yield* armBootSentinelEffect();
    }
    const { setWezTermTabTitleEffect } = yield* step("load WezTerm integration", () => import("./core/wezterm.ts"));
    yield* setWezTermTabTitleEffect("wt", config.paths.weztermCli).pipe(
      Effect.catch(() => Effect.void),
    );
    const { runTuiEffect } = yield* step("load TUI", () => import("./tui/runtime.tsx"));
    yield* runTuiEffect.pipe(
      Effect.mapError((cause) => new MainStepError({ step: "run TUI", cause })),
    );
    if (process.env.WT_UPDATE !== "off") {
      const { completeBootSentinel } = yield* step("load boot completion", () => import("./core/update.ts"));
      yield* Effect.sync(completeBootSentinel);
    }
    return 0;
  });
}

const program = mainEffect().pipe(
  Effect.scoped,
  Effect.catchCause((cause) =>
    Effect.gen(function* () {
      const error = reportedCause(Cause.squash(cause));
      yield* Effect.sync(() => {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      });
      // If this version is a fresh update that never booted healthy, offer
      // to roll back to the one that did. The offer path is config-free
      // (core/update.ts) so it works even when the crash IS the config
      // loader rejecting the user's config; it re-execs on acceptance and
      // must never mask the original error otherwise.
      const rollback = yield* step("load crash rollback", () =>
        import("./cli/commands/rollback.ts"),
      ).pipe(Effect.option);
      if (rollback._tag === "Some") {
        yield* rollback.value.maybeOfferCrashRollbackEffect();
      }
      return 1;
    }),
  ),
  // Drain the log write chain before the hard exit below. Every log
  // write is an async `appendFile`, so a short CLI command that returns
  // immediately (`wt status`, `wt section`) would otherwise exit with
  // its lines still queued — silently losing the file-only audit trail
  // those commands deliberately write, and any warning raised during a
  // read. The TUI flushes in its own shutdown path; this covers
  // everything else. Best-effort: a logging failure must never change a
  // command's exit code.
  Effect.ensuring(
    step("load logger", () => import("./core/logger.ts")).pipe(
      Effect.flatMap(({ flushLoggerEffect }) => flushLoggerEffect),
      Effect.catch(() => Effect.void),
    ),
  ),
);

const code = await Effect.runPromise(program);
  // Explicit exit: the TUI path can leave behind background listeners
  // (persister sub, refetch intervals, sqlite handle) that keep the
  // event loop alive even after cleanup. A hard exit is the standard
  // CLI pattern here.
process.exit(code);
