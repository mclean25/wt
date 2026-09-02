/**
 * Interactive skills/instructions sync — the ONE flow behind both the
 * TUI startup check (main.ts, before the terminal is taken over) and
 * `wt skills sync`. Asks y/n once per pending unit; a "no" is
 * remembered per (content version, target) and never re-asked until
 * either changes. Template vars are asked once and remembered forever
 * (`wt skills reset` clears).
 *
 * Mutations (apply + regenerate) run under a cross-process lock, with
 * reports rebuilt inside it — two concurrent syncs serialize, and the
 * second sees the first's writes as fresh and applies nothing.
 */
import { Cause, Data, Effect } from "effect";

import {
  applyReport,
  buildReports,
  declineKey,
  detectTargets,
  readSkillsMemory,
  regenRulesync,
  rememberAnswer,
  rememberDecline,
  reportIsActionable,
  touchedRulesyncRoots,
  unitKey,
  UNITS,
  type Unit,
  type UnitReport,
} from "../core/skills.ts";
import { withAsyncFileLockEffect } from "../core/locks.ts";
import { createLogger } from "../core/logger.ts";
import { bold, cyan, dim, green, red, yellow } from "./colors.ts";
import { askEffect, confirmEffect, isInteractive } from "./prompt.ts";

const log = createLogger("[skills]");

export type SyncMode = {
  /** Prompt on a TTY; false = only act on what `yes`/`force` allow. */
  interactive: boolean;
  /** Accept every missing/outdated unit without prompting. */
  yes: boolean;
  /** Allow overwriting modified/unmanaged copies (explicit opt-in). */
  force: boolean;
  /** Restrict to these unit names (also overrides remembered declines). */
  names: string[] | null;
  /** Startup context: stay silent when there is nothing to do. */
  startup: boolean;
};

class SkillsSyncError extends Data.TaggedError("SkillsSyncError")<{
  readonly operation: "prompt" | "lock" | "apply" | "regenerate";
  readonly cause: unknown;
}> {}

function targetLabel(r: UnitReport): string {
  return r.target.kind === "rulesync" ? `rulesync ${r.target.rulesync.root}` : r.path;
}

/** Pending reports grouped per unit, registry order. */
function groupPending(reports: UnitReport[], explicit: boolean): Map<Unit, UnitReport[]> {
  const byUnit = new Map<Unit, UnitReport[]>();
  for (const r of reports) {
    // An explicit `wt skills sync <name>` overrides a remembered decline.
    const actionable = explicit
      ? r.state === "missing" || r.state === "outdated" || r.state === "modified"
      : reportIsActionable(r);
    if (!actionable) continue;
    const list = byUnit.get(r.unit) ?? [];
    list.push(r);
    byUnit.set(r.unit, list);
  }
  return byUnit;
}

/** Decline-memory writes must never abort the remaining prompts. */
function tryRemember(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    log.error(err instanceof Error ? err : String(err));
    console.error(dim("  (could not persist to skills memory — this choice may be re-asked)"));
  }
}

/**
 * Run the sync. Returns a process exit code. Never throws for
 * per-unit failures — they're printed and reflected in the code.
 */
export function runSkillsSyncEffect(mode: SyncMode): Effect.Effect<number, SkillsSyncError> {
  return Effect.gen(function* () {
    const targets = detectTargets();
    if (targets.harnesses.length === 0) {
      if (!mode.startup)
        console.log(
          dim("no agent harness dirs found (~/.claude, ~/.codex, ~/.config/opencode) — nothing to install into"),
        );
      return 0;
    }
    const filterNames = (reports: UnitReport[]): UnitReport[] =>
      mode.names ? reports.filter((r) => mode.names!.includes(r.unit.name)) : reports;
    if (mode.names) {
      const known = new Set(UNITS.map((u) => u.name));
      const unknown = mode.names.filter((n) => !known.has(n));
      if (unknown.length > 0) {
        console.error(red(`unknown unit(s): ${unknown.join(", ")} (have: ${[...known].join(", ")})`));
        return 2;
      }
    }
    let memory = readSkillsMemory();
    let reports = filterNames(buildReports(targets, memory));

    const pending = groupPending(reports, mode.names !== null);
    if (pending.size === 0) {
      if (!mode.startup) console.log(green("✓ agent skills and instructions are up to date"));
      return 0;
    }

    if (!mode.interactive && !mode.yes) {
      console.log(yellow(`${pending.size} pending unit(s):`));
      for (const [unit, rs] of pending) {
        console.log(`  ${bold(unit.name)} — ${rs.map((r) => r.state).join(", ")}`);
      }
      console.log(dim("re-run interactively, or pass --yes (add --force to overwrite modified copies)"));
      return 1;
    }

    if (mode.startup) {
      console.log(bold(`wt: ${pending.size} agent-skill update(s) available`));
      console.log(
        dim(
          '(answers are remembered; "no" never re-asks for the same version. [skills] startup_check = false disables this check)',
        ),
      );
    }

    // Phase 1: decide per unit.
    const accepted: Unit[] = [];
    for (const [unit, rs] of pending) {
      const states = new Set(rs.map((r) => r.state));
      const hasModified = states.has("modified");
      const verb = states.has("missing") ? "Install" : "Update";
      if (hasModified) {
        // A modified/unmanaged copy always gets the explicit disclosure
        // prompt when we CAN ask — --force only substitutes for it in
        // non-interactive runs.
        if (!mode.interactive) {
          if (!mode.force) {
            console.log(
              yellow(
                `~ ${unit.name}: local copy differs (not wt-managed) — skipped; use \`wt skills sync ${unit.name} --force\` or run interactively`,
              ),
            );
            continue;
          }
          accepted.push(unit);
          continue;
        }
        const detail = rs.find((r) => r.detail)?.detail ?? "local copy differs";
        if (
          !(yield* confirmEffect(
            `${yellow("~")} ${bold(unit.name)}: ${detail}. Overwrite with the wt-managed version?`,
            false,
          ))
        ) {
          tryRemember(() => {
            for (const r of rs) rememberDecline(declineKey(unit, r.target), r.canonicalHash);
          });
          console.log(dim(`  keeping your copy (won't ask again for this version)`));
          continue;
        }
        accepted.push(unit);
        continue;
      }
      if (mode.yes) {
        accepted.push(unit);
        continue;
      }
      const what =
        unit.kind === "instructions"
          ? `${verb} the managed wt block in your agent instructions file(s)?`
          : `${verb} skill ${bold(unit.name)} ${dim(`(${unit.summary})`)}?`;
      if (yield* confirmEffect(`${cyan("•")} ${what}`, true)) {
        accepted.push(unit);
      } else {
        tryRemember(() => {
          for (const r of rs) rememberDecline(declineKey(unit, r.target), r.canonicalHash);
        });
        console.log(dim("  skipped (won't ask again for this version)"));
      }
    }
    if (accepted.length === 0) return 0;

    // Phase 2a: applying into a rulesync target also executes that
    // pipeline's regenerate command. Name the exact command and confirm
    // once per root — running a discovered command deserves its own yes.
    const acceptedSet = new Set(accepted.map((u) => unitKey(u)));
    const skippedRoots = new Set<string>();
    if (mode.interactive) {
      const acceptedReports = reports.filter((r) => acceptedSet.has(unitKey(r.unit)) && r.target.kind === "rulesync");
      for (const rs of touchedRulesyncRoots(acceptedReports)) {
        const ok = yield* confirmEffect(
          `${cyan("•")} ${bold(rs.root)} is rulesync-managed: applying will run ${bold(rs.regen.join(" "))} there. Continue?`,
          true,
        );
        if (!ok) {
          skippedRoots.add(rs.root);
          console.log(dim("  skipping that target this run (nothing remembered)"));
        }
      }
    }

    // Phase 2b: fill template blanks for accepted units (asked once, global keys).
    const asked = new Set<string>();
    for (const unit of accepted) {
      for (const v of unit.vars) {
        if (v.key in memory.answers || asked.has(v.key)) continue;
        asked.add(v.key);
        if (!mode.interactive) continue; // fallback text renders; a later interactive run can still answer
        const answer = (yield* askEffect(`${cyan("?")} ${v.prompt}: `)).trim();
        tryRemember(() => rememberAnswer(v.key, answer));
      }
    }

    // Phase 3+4 under the cross-process lock: rebuild with the new
    // answers (and any concurrent process's writes — already-applied
    // units come back "fresh" and drop out), apply, regenerate once per
    // touched rulesync pipeline.
    let failures = 0;
    yield* withAsyncFileLockEffect(
      "__skills_sync__",
      Effect.gen(function* () {
        memory = readSkillsMemory();
        reports = filterNames(buildReports(targets, memory));
        const toApply = reports.filter(
          (r) =>
            acceptedSet.has(unitKey(r.unit)) &&
            (r.state === "missing" || r.state === "outdated" || r.state === "modified") &&
            !(r.target.kind === "rulesync" && skippedRoots.has(r.target.rulesync.root)),
        );
        const applied: UnitReport[] = [];
        for (const r of toApply) {
          const result = yield* Effect.either(
            Effect.try({
              try: () => applyReport(r),
              catch: (cause) => new SkillsSyncError({ operation: "apply", cause }),
            }),
          );
          if (result._tag === "Right") {
            applied.push(r);
            console.log(`${green("✓")} ${bold(r.unit.name)} ${dim("→")} ${targetLabel(r)}`);
          } else {
            failures++;
            const cause = result.left.cause;
            const msg = cause instanceof Error ? cause.message : String(cause);
            console.error(red(`✗ ${r.unit.name}: ${msg}`));
            log.error(cause instanceof Error ? cause : String(cause), {
              unit: r.unit.name,
            });
          }
        }

        const roots = touchedRulesyncRoots(applied);
        if (roots.length > 0) {
          for (const rs of roots) {
            console.log(dim(`regenerating rulesync output (${rs.regen.join(" ")}) …`));
          }
          const results = yield* Effect.tryPromise({
            try: () => regenRulesync(roots),
            catch: (cause) => new SkillsSyncError({ operation: "regenerate", cause }),
          });
          for (const result of results) {
            if (result.ok) {
              console.log(`${green("✓")} rulesync regenerated ${dim(result.root)}`);
            } else {
              failures++;
              console.error(red(`✗ rulesync regenerate failed in ${result.root}:`));
              if (result.output.trim()) console.error(result.output.trim());
              console.error(dim("the sources under .rulesync/ are updated; re-run the generator manually"));
            }
          }
        }
      }),
    );
    return failures > 0 ? 1 : 0;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof SkillsSyncError
        ? cause
        : new SkillsSyncError({
            operation: cause._tag === "PromptError" ? "prompt" : "lock",
            cause,
          }),
    ),
  );
}

/**
 * Pre-TUI startup check (main.ts). Only runs with a real interactive
 * terminal on BOTH ends — a non-tty stdin would turn prompts into
 * silent auto-accepts (EOF) or an indefinite block. Never blocks the
 * TUI on a bug in the skills system — unexpected errors are logged
 * and swallowed.
 */
export function startupSkillsPromptEffect(): Effect.Effect<void> {
  if (!isInteractive()) return Effect.void;
  return runSkillsSyncEffect({
    interactive: true,
    yes: false,
    force: false,
    names: null,
    startup: true,
  }).pipe(
    Effect.asVoid,
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        log.error(Cause.pretty(cause));
        console.error(dim("wt: skills startup check failed (see app log); starting anyway"));
      }),
    ),
  );
}
