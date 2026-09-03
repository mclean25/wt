/**
 * `wt skills` — manage the agent skills + instructions wt distributes.
 *
 * wt is the single source of truth for its own agent tooling: bundled
 * skills (`skills/<name>/SKILL.md` in the wt checkout) and a managed
 * always-on instructions block. This command reports freshness,
 * syncs updates (the same flow the TUI runs at startup), shows diffs,
 * and clears the remembered template answers / declines.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { operationErrors } from "../../core/errors.ts";
import { run as sh } from "../../core/proc.ts";
import {
  buildReports,
  clearSkillsMemory,
  detectTargets,
  NO_TOOLS_HINT,
  extractInstructionsBlock,
  readSkillsMemory,
  reportIsActionable,
  SKILLS_MEMORY_FILE,
  UNITS,
  type UnitReport,
  type UnitState,
} from "../../core/skills.ts";
import { hasHelpFlag } from "../args.ts";
import { bold, cyan, dim, green, red, yellow } from "../colors.ts";
import { isInteractive } from "../prompt.ts";
import { runSkillsSync } from "../skills-sync.ts";

const USAGE = `usage: wt skills [status|sync|diff|reset] [options]

wt is the single source of the agent skills + instructions it relies
on. This command keeps the installed copies current across every
coding agent on the machine (claude / codex / opencode / pi),
following
symlinks and writing through rulesync pipelines when one manages the
target (durable source + regenerate, never the generated output).

  wt skills [status]          freshness of every unit at every target
  wt skills sync [<name>...]  interactively install/update pending units;
                              naming a unit explicitly re-offers one you
                              previously declined
      --yes / -y              accept every missing/outdated unit, no prompts
                              (modified/personal copies are still skipped)
      --force                 non-interactive only: also overwrite modified
                              copies (interactive runs always ask per copy)
  wt skills diff <name>       what a sync would change (unified diff; for
                              the instructions block, old vs new block)
  wt skills reset             forget remembered template answers + declines
      --answers | --declines  reset only one of the two

The TUI runs the same check at startup ([skills] startup_check,
default true) and asks y/n once per pending update — a "no" is
remembered per content version and never re-asked. \`install\` is an
alias of \`sync\`.`;

const STATE_STYLE: Record<UnitState, { glyph: string; label: string }> = {
  fresh: { glyph: green("✓"), label: "up to date" },
  outdated: { glyph: yellow("↑"), label: "update available" },
  missing: { glyph: cyan("+"), label: "not installed" },
  modified: { glyph: yellow("~"), label: "local copy differs" },
  blocked: { glyph: red("✗"), label: "unmanageable" },
};

function targetName(r: UnitReport): string {
  const harnesses = r.target.harnesses.join(", ");
  return r.target.kind === "rulesync" ? `rulesync ${r.target.rulesync.root} (${harnesses})` : `${harnesses}`;
}

function status(): number {
  const targets = detectTargets();
  if (targets.harnesses.length === 0) {
    console.log(dim(NO_TOOLS_HINT));
    return 0;
  }
  const memory = readSkillsMemory();
  const reports = buildReports(targets, memory);
  console.log(bold("agent skills & instructions"));
  console.log(dim(`harnesses: ${targets.harnesses.join(", ")}`));
  let pending = 0;
  for (const r of reports) {
    const s = STATE_STYLE[r.state];
    if (reportIsActionable(r)) pending++;
    const declined = r.declined ? dim(" (declined for this version)") : "";
    const detail = r.detail ? dim(` — ${r.detail}`) : "";
    console.log(
      `  ${s.glyph} ${bold(r.unit.name.padEnd(13))} ${s.label.padEnd(18)} ${dim(targetName(r))}${declined}${detail}`,
    );
  }
  const answers = Object.entries(memory.answers);
  if (answers.length > 0) {
    console.log(dim("\nremembered answers (wt skills reset --answers):"));
    for (const [k, v] of answers) {
      console.log(dim(`  ${k} = ${v === "" ? "(empty — fallback text used)" : JSON.stringify(v)}`));
    }
  }
  console.log();
  if (pending > 0) {
    console.log(`${yellow(String(pending))} pending — run ${bold("wt skills sync")}`);
  } else {
    console.log(green("everything up to date"));
  }
  return 0;
}

const io = operationErrors("wt skills");

function diff(name: string | undefined) {
  if (!name || hasHelpFlag([name])) {
    return Effect.sync(() => {
      console.log(name ? USAGE : red("usage: wt skills diff <name>"));
      return name ? 0 : 2;
    });
  }
  const targets = detectTargets();
  const reports = buildReports(targets, readSkillsMemory()).filter((r) => r.unit.name === name);
  if (reports.length === 0) {
    return Effect.sync(() => {
      console.error(red(`unknown unit: ${name} (have: ${UNITS.map((u) => u.name).join(", ")})`));
      return 2;
    });
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "wt-skills-diff-"))),
    (tmpDir) =>
      Effect.gen(function* () {
        for (const r of reports) {
          if (r.state === "fresh") {
            console.log(`${green("✓")} ${targetName(r)}: up to date`);
            continue;
          }
          if (r.state === "blocked") {
            console.log(`${red("✗")} ${targetName(r)}: ${r.detail ?? "unmanageable"}`);
            continue;
          }
          const expectedFile = join(tmpDir, `${name}.expected`);
          writeFileSync(expectedFile, r.expected);
          console.log(bold(`--- ${targetName(r)} (${r.state})`));
          // What the diff runs against: the installed skill file, or the
          // current managed block extracted from the instructions file.
          let installedFile: string | null = null;
          if (r.unit.kind === "skill") {
            installedFile = existsSync(r.path) ? r.path : null;
          } else if (existsSync(r.path)) {
            const block = extractInstructionsBlock(readFileSync(r.path, "utf8"));
            if (block !== null) {
              installedFile = join(tmpDir, `${name}.installed`);
              writeFileSync(installedFile, block.body);
            }
          }
          if (installedFile === null) {
            // Nothing installed yet — the "diff" is the whole expected content.
            console.log(r.expected);
            continue;
          }
          const d = yield* sh(["diff", "-u", installedFile, expectedFile]).pipe(
            Effect.mapError(io.wrap("diff")),
          );
          console.log(d.stdout.trim() === "" ? dim("(differs only by stamp)") : d.stdout);
        }
        return 0;
      }),
    (tmpDir) => Effect.sync(() => rmSync(tmpDir, { recursive: true, force: true })),
  );
}

function reset(argv: string[]): number {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  let answers = false;
  let declines = false;
  for (const a of argv) {
    if (a === "--answers") answers = true;
    else if (a === "--declines") declines = true;
    else {
      console.error(red(`unknown flag: ${a}`));
      return 2;
    }
  }
  if (!answers && !declines) {
    answers = true;
    declines = true;
  }
  clearSkillsMemory({ answers, declines });
  const what = [answers ? "answers" : null, declines ? "declines" : null].filter(Boolean).join(" + ");
  console.log(`${green("✓")} cleared ${what} ${dim(`(${SKILLS_MEMORY_FILE})`)}`);
  if (declines) console.log(dim("previously declined updates will be offered again"));
  return 0;
}

function sync(argv: string[]) {
  if (hasHelpFlag(argv)) {
    return Effect.sync(() => {
      console.log(USAGE);
      return 0;
    });
  }
  let yes = false;
  let force = false;
  const names: string[] = [];
  for (const a of argv) {
    if (a === "--yes" || a === "-y") yes = true;
    else if (a === "--force") force = true;
    else if (a.startsWith("-")) {
      console.error(red(`unknown flag: ${a}\n`));
      console.error(USAGE);
      return Effect.succeed(2);
    } else names.push(a);
  }
  return runSkillsSync({
    // Both ends must be a TTY: a redirected stdout would print the
    // prompts into the redirect while the terminal looks hung.
    interactive: isInteractive() && !yes,
    yes,
    force,
    names: names.length > 0 ? names : null,
    startup: false,
  }).pipe(Effect.mapError(io.wrap("sync")));
}

export const run = Effect.fn("wt skills")(function* (argv: string[]) {
  const [sub, ...rest] = argv;
  if (hasHelpFlag([sub ?? ""])) {
    console.log(USAGE);
    return 0;
  }
  switch (sub) {
    case undefined:
    case "status":
      return status();
    case "sync":
    case "install": // legacy alias
      return yield* sync(rest);
    case "diff":
      return yield* diff(rest[0]);
    case "reset":
      return reset(rest);
    default:
      console.error(red(`unknown skills subcommand: ${sub}\n`));
      console.error(USAGE);
      return 2;
  }
});
