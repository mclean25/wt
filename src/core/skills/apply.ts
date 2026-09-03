/**
 * The write side: install/update a unit at a target, and regenerate
 * rulesync pipelines afterwards (once per touched root, not per unit).
 *
 * Skill installs stage into a temp sibling and swap via rename, so a
 * failed write can't leave the old skill deleted with nothing in its
 * place — and the rename replaces a symlinked dest rather than writing
 * through it. Instructions splices are write-tmp + rename for the same
 * torn-read reason as wtstate.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";

import { causeMessage, operationErrors } from "../errors.ts";
import { run } from "../proc.ts";
import type { UnitReport } from "./report.ts";
import type { RulesyncInfo } from "./targets.ts";
import { unitSourcePath } from "./registry.ts";
import { spliceInstructionsBlock, stampContent } from "./template.ts";

const io = operationErrors("skills/apply");

function dispatchApply(report: UnitReport): void {
  if (report.unit.kind === "skill") {
    applySkill(report);
  } else {
    applyInstructions(report);
  }
}

/** Effect-native write path for scoped command composition. */
export const applyReport = Effect.fn("applyReport")(function* (report: UnitReport) {
  yield* io.sync(`apply ${report.unit.name}`, () => dispatchApply(report));
});

function applySkill(report: UnitReport): void {
  const destDir = dirname(report.path); // <skills root>/<name>
  const destRoot = dirname(destDir);
  const name = report.unit.name;
  mkdirSync(destRoot, { recursive: true });
  // Reap staged dirs abandoned by earlier crashed/killed runs — they
  // carry a different pid, so the own-path cleanup below never sees
  // them, and apply runs are serialized (skills-sync lock), so any
  // sibling matching the pattern is dead.
  for (const entry of readdirSync(destRoot)) {
    if (entry.startsWith(`.${name}.tmp-`)) {
      rmSync(join(destRoot, entry), { recursive: true, force: true });
    }
  }
  const staged = join(destRoot, `.${name}.tmp-${process.pid}`);
  let swapped = false;
  try {
    // Bring support files along (future skills may carry scripts);
    // SKILL.md itself is replaced with the rendered + stamped content.
    cpSync(dirname(unitSourcePath(report.unit)), staged, { recursive: true });
    writeFileSync(join(staged, "SKILL.md"), stampContent(report.expected));
    // force:true also removes a dangling symlink at destDir (which
    // existsSync would miss) so the rename can't hit ENOTDIR.
    rmSync(destDir, { recursive: true, force: true });
    renameSync(staged, destDir);
    swapped = true;
  } finally {
    if (!swapped && existsSync(staged)) {
      if (!existsSync(destDir)) {
        // The old copy is already gone and the swap failed: staged is
        // the ONLY surviving content. Try once more to land it; if
        // that fails too, LEAVE it for recovery — deleting it here
        // would destroy the skill entirely.
        try {
          renameSync(staged, destDir);
        } catch {
          /* staged intentionally left in place */
        }
      } else {
        rmSync(staged, { recursive: true, force: true });
      }
    }
  }
}

function applyInstructions(report: UnitReport): void {
  const file = report.path;
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = spliceInstructionsBlock(current, report.expected);
  if (next === current) return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, next);
  renameSync(tmp, file);
}

/** Distinct rulesync roots touched by a set of applied reports. */
export function touchedRulesyncRoots(applied: UnitReport[]): RulesyncInfo[] {
  const byRoot = new Map<string, RulesyncInfo>();
  for (const r of applied) {
    if (r.target.kind === "rulesync") byRoot.set(r.target.rulesync.root, r.target.rulesync);
  }
  return [...byRoot.values()];
}

export type RegenResult = {
  root: string;
  ok: boolean;
  output: string;
  /**
   * Files left uncommitted in the pipeline's repo, or null when that
   * can't be determined (not a git repo, git unavailable, regen
   * failed).
   */
  uncommitted: number | null;
};

/**
 * Uncommitted files in a rulesync root, or null when the question
 * doesn't apply. A dotfiles pipeline commits BOTH its `.rulesync/`
 * source and the generated output, so wt writing + regenerating
 * leaves the repo dirty; unmentioned, that update survives only until
 * the next fresh clone or `git checkout --`, and the repo's own
 * `--check` gate then fails on a change nobody remembers making.
 */
function uncommittedCount(root: string): Effect.Effect<number | null> {
  return run(["git", "status", "--porcelain"], { cwd: root, timeoutMs: 30_000 }).pipe(
    Effect.map((r) =>
      // A timed-out (SIGKILLed) git has captured nothing, which is
      // indistinguishable from a clean tree — report unknown.
      r.exitCode !== 0 || r.timedOut
        ? null
        : r.stdout.split("\n").filter((line) => line.trim() !== "").length,
    ),
    Effect.catch(() => Effect.succeed(null)),
  );
}

/** Run each root's regenerate command; the sources are already durable, so a failure is reported, not fatal. */
export function regenRulesync(roots: RulesyncInfo[]): Effect.Effect<RegenResult[]> {
  return Effect.forEach(roots, (rs) =>
    // Bun.spawn throws synchronously when the binary itself is
    // missing (ENOENT on bash/npx) — that must degrade to a per-root
    // failure like any non-zero exit, not abort the remaining roots.
    run(rs.regen, { cwd: rs.root, timeoutMs: 180_000 }).pipe(
      Effect.flatMap((r) =>
        (r.exitCode === 0 ? uncommittedCount(rs.root) : Effect.succeed(null)).pipe(
          Effect.map((uncommitted) => ({
            root: rs.root,
            ok: r.exitCode === 0,
            output: [r.stdout, r.stderr].filter((s) => s.trim() !== "").join("\n"),
            uncommitted,
          })),
        ),
      ),
      Effect.catch((err) => Effect.succeed({
        root: rs.root,
        ok: false,
        output: causeMessage(err),
        uncommitted: null,
      })),
    ),
    { concurrency: 1 },
  );
}
