import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Data, Effect } from "effect";

import { config } from "../../core/config.ts";
import { branchIsMerged, gitQuiet } from "../../core/git.ts";
import { fetchPrs } from "../../core/github.ts";
import { claudeTmuxName } from "../../core/harness/claude/harness.ts";
import { claudeInjectSelftest, shimDir, staleShims } from "../../core/harness/claude/inject.ts";
import { humanAge, lockAge, lockLabel, lockStatus } from "../../core/locks.ts";
import { run as runProcess, type RunResult } from "../../core/proc.ts";
import { buildReports, detectTargets, readSkillsMemory, reportIsActionable } from "../../core/skills.ts";
import { computeStage } from "../../core/stage.ts";
import { isOurStageDeployed } from "../../core/stage-safety.ts";
import { listSessions } from "../../core/tmux/admin.ts";
import type { Check, CheckStatus, Worktree } from "../../core/types.ts";
import { listWorktrees, worktreeAtCwd } from "../../core/worktree.ts";
import { readWtState } from "../../core/wtstate.ts";
import { hasHelpFlag } from "../args.ts";
import { bold, cyan, dim, green, red, yellow } from "../colors.ts";
import { renderPrCell, renderSlugCell, renderStageCell, renderTable } from "../render.ts";

const USAGE = `usage: wt doctor [<slug>] [options]

Health report: working tree, sync vs trunk, SST stage pin + deploy
state, node_modules, locks, merged status, PR/CI. One worktree (or the
one containing cwd), or all with --all. Also banners machine-level
issues: a main clone off its trunk branch, and pending agent-skill
updates.

  --all, -a    force the full summary table
  --json       machine-readable`;

const STATUS_RANK: Record<CheckStatus, number> = {
  ok: 0,
  info: 0,
  warn: 1,
  err: 2,
};
function worst(statuses: CheckStatus[]): CheckStatus {
  if (statuses.length === 0) return "ok";
  return statuses.reduce((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a));
}

const MARKERS: Record<CheckStatus, string> = {
  ok: green("✓"),
  info: cyan("·"),
  warn: yellow("⚠"),
  err: red("✗"),
};

function mkCheck(name: string, status: CheckStatus, message: string, detail: string[] = []): Check {
  return { name, status, message, detail };
}

function procEffect(argv: readonly string[], opts: Parameters<typeof runProcess>[1] = {}): Effect.Effect<RunResult, DoctorCommandError> {
  return runProcess(argv, opts).pipe(Effect.mapError((cause) => new DoctorCommandError({ cause })));
}

function syncEffect<A>(f: () => A): Effect.Effect<A, DoctorCommandError> {
  return Effect.try({ try: f, catch: (cause) => new DoctorCommandError({ cause }) });
}


function checkWorkingTree(wt: Worktree): Effect.Effect<Check, DoctorCommandError> {
  return procEffect(["git", "status", "--porcelain"], { cwd: wt.path }).pipe(Effect.map((r) => {
    if (r.exitCode !== 0) return mkCheck("working tree", "err", `git status failed: ${r.stderr.trim()}`);
    if (!r.stdout.trim()) return mkCheck("working tree", "ok", "clean");
    const lines = r.stdout.split("\n").filter(Boolean);
    return mkCheck("working tree", "warn", `${lines.length} uncommitted change(s)`, lines.slice(0, 10));
  }));
}

function checkSync(wt: Worktree): Effect.Effect<Check, DoctorCommandError> {
  return Effect.gen(function* () {
    const r = yield* procEffect(["git", "rev-list", "--left-right", "--count", `origin/${config.branch.base}...HEAD`], { cwd: wt.path });
    const trunk = `origin/${config.branch.base}`;
    if (r.exitCode !== 0) return mkCheck("sync", "warn", `cannot compare to ${trunk}`);
    const parts = r.stdout.trim().split(/\s+/);
    const behind = parseInt(parts[0] ?? "0", 10);
    const ahead = parseInt(parts[1] ?? "0", 10);
    let unpushed = 0;
    const upstreamR = yield* procEffect(["git", "rev-parse", "--abbrev-ref", "@{u}"], { cwd: wt.path });
    if (upstreamR.exitCode === 0) {
      const cr = yield* procEffect(["git", "rev-list", "--count", "@{u}..HEAD"], { cwd: wt.path });
      if (cr.exitCode === 0) unpushed = parseInt(cr.stdout.trim(), 10) || 0;
    } else {
      const branchR = yield* procEffect(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt.path });
      const branch = branchR.stdout.trim();
      if (branch && branch !== "HEAD") {
        const hasRemote = yield* gitQuiet(["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`], wt.path).pipe(
          Effect.mapError((cause) => new DoctorCommandError({ cause })),
        );
        if (hasRemote) {
          const cr = yield* procEffect(["git", "rev-list", "--count", `origin/${branch}..HEAD`], { cwd: wt.path });
          if (cr.exitCode === 0) unpushed = parseInt(cr.stdout.trim(), 10) || 0;
        } else unpushed = ahead;
      }
    }
    const bits: string[] = [];
    if (ahead) bits.push(`${ahead} ahead of ${trunk}`);
    if (behind) bits.push(`${behind} behind ${trunk}`);
    if (unpushed) bits.push(`${unpushed} unpushed`);
    if (bits.length === 0) return mkCheck("sync", "ok", "up to date");
    const status: CheckStatus = behind || unpushed ? "warn" : "info";
    return mkCheck("sync", status, bits.join("; "));
  });
}

function checkSstStage(wt: Worktree): Effect.Effect<Check, DoctorCommandError> {
  return syncEffect(() => {
  const stageFile = join(wt.path, ".sst", "stage");
  if (!existsSync(stageFile)) return mkCheck("sst stage", "warn", "no .sst/stage pinned");
  let actual = "";
  try {
    actual = readFileSync(stageFile, "utf8").trim();
  } catch {
    return mkCheck("sst stage", "warn", "cannot read .sst/stage");
  }
  const expected = computeStage(wt.slug);
  if (actual === expected) return mkCheck("sst stage", "ok", `pinned to ${actual}`);
  return mkCheck("sst stage", "warn", `stage=${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  });
}

function checkSstDeploy(wt: Worktree): Effect.Effect<Check, DoctorCommandError> {
  return syncEffect(() => {
  if (!isOurStageDeployed(wt)) return mkCheck("sst deploy", "info", "not deployed");
  try {
    const st = statSync(join(wt.path, ".sst", "outputs.json"));
    const age = (Date.now() - st.mtimeMs) / 1000;
    return mkCheck("sst deploy", "info", `deployed (${humanAge(age)} ago)`);
  } catch {
    return mkCheck("sst deploy", "info", "deployed");
  }
  });
}
/**
 * Lockfile → the install command that produced it. Same detection the
 * `[lifecycle] install_command` default uses, so the advice doctor
 * prints matches what wt would actually run. Ordered most-specific
 * first; `null` means the checkout has no JS package manager at all
 * and the whole check is inapplicable.
 */
function detectPackageManager(path: string): { install: string; store: string | null } | null {
  const lockfiles: [file: string, install: string, store: string | null][] = [
    // pnpm's store is the one layout where node_modules can exist and
    // still be unusable (a bare symlink tree with no .pnpm behind it),
    // so it gets a second existence probe; the others don't.
    ["pnpm-lock.yaml", "pnpm install", ".pnpm"],
    ["bun.lock", "bun install", null],
    ["bun.lockb", "bun install", null],
    ["yarn.lock", "yarn install", null],
    ["package-lock.json", "npm install", null],
    ["npm-shrinkwrap.json", "npm install", null],
  ];
  for (const [file, install, store] of lockfiles) {
    if (existsSync(join(path, file))) return { install, store };
  }
  return existsSync(join(path, "package.json")) ? { install: "npm install", store: null } : null;
}

/**
 * Packages sitting at the top of a pnpm `node_modules` as REAL
 * directories rather than symlinks into `.pnpm`, plus those among them
 * whose version the virtual store does not have.
 *
 * Under `nodeLinker: isolated` — pnpm's default, and the only mode this
 * looks at — every package entry is a symlink. A real directory there is
 * something pnpm did not put there, and pnpm will not remove it: the
 * store is pruned against the lockfile while the top level is left
 * alone, so `pnpm install` prints `Already up to date` over a tree whose
 * resolution is frozen at whenever the directory was written.
 *
 * That is a lie in the worst available direction, because it is LOCAL
 * only. CI installs from the lockfile into an empty tree and sees the
 * right versions, so the two disagree with nothing to say which is
 * wrong — measured here as a typecheck failing on a member the installed
 * version does have, and it fails green just as easily.
 *
 * Returns null when the question does not apply (not pnpm, no store, or
 * a linker whose layout makes real directories correct). Absence of an
 * answer is never reported as a clean one.
 */
export function pnpmPhantomTopLevel(nm: string): { phantoms: string[]; drifted: string[] } | null {
  let linker: unknown;
  try {
    linker = (
      JSON.parse(readFileSync(join(nm, ".modules.yaml"), "utf8")) as {
        nodeLinker?: unknown;
      }
    ).nodeLinker;
  } catch {
    // pnpm writes this file on every install and it is JSON-compatible
    // YAML. Unreadable means we cannot establish the layout, so we do
    // not get to have an opinion about it.
    return null;
  }
  if (linker !== "isolated") return null;

  // Every version the virtual store holds, keyed by package name. The
  // directory name is `<name>@<version>` with `/` written `+` and any
  // peer-suffix after `_`.
  const store = new Map<string, Set<string>>();
  let entries: string[];
  try {
    entries = readdirSync(join(nm, ".pnpm"));
  } catch {
    return null;
  }
  for (const e of entries) {
    const m = /^(.+)@(\d[^_]*?)(?:_.*)?$/.exec(e);
    if (!m) continue;
    const name = m[1]!.replace(/^(@[^+]+)\+/, "$1/");
    (store.get(name) ?? store.set(name, new Set()).get(name)!).add(m[2]!);
  }

  const phantoms: string[] = [];
  const drifted: string[] = [];
  const walk = (dir: string, scope: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of names) {
      if (e.startsWith(".")) continue;
      const full = join(dir, e);
      let st;
      try {
        st = lstatSync(full);
      } catch {
        continue;
      }
      // A symlink is the correct shape and the common case, so it costs
      // one lstat and nothing else.
      if (st.isSymbolicLink() || !st.isDirectory()) continue;
      // `@scope` is a real directory by design; its children are the
      // package entries.
      if (!scope && e.startsWith("@")) {
        walk(full, `${e}/`);
        continue;
      }
      const name = `${scope}${e}`;
      phantoms.push(name);
      let version: unknown;
      try {
        version = (
          JSON.parse(readFileSync(join(full, "package.json"), "utf8")) as {
            version?: unknown;
          }
        ).version;
      } catch {
        continue;
      }
      const have = store.get(name);
      if (have && typeof version === "string" && !have.has(version)) {
        drifted.push(`${name} ${version} → ${[...have].join(", ")}`);
      }
    }
  };
  walk(nm, "");
  return { phantoms, drifted };
}

function checkNodeModules(wt: Worktree): Effect.Effect<Check, DoctorCommandError> {
  return syncEffect(() => {
  const pm = detectPackageManager(wt.path);
  if (!pm) return mkCheck("node_modules", "info", "no JS package manager");
  const nm = join(wt.path, "node_modules");
  const missing = !existsSync(nm) || (pm.store !== null && !existsSync(join(nm, pm.store)));
  if (missing) {
    return mkCheck("node_modules", "warn", `not installed — run \`${pm.install}\``);
  }
  const stray = pm.store === ".pnpm" ? pnpmPhantomTopLevel(nm) : null;
  if (stray && stray.drifted.length > 0) {
    // `pnpm install` cannot clear this — it reports the tree up to date
    // and leaves the top level as it found it. The directory has to go.
    return mkCheck(
      "node_modules",
      "warn",
      `${stray.drifted.length} of ${stray.phantoms.length} unmanaged top-level package(s) resolve to a version the lockfile does not have — \`rm -rf node_modules && ${pm.install}\``,
      stray.drifted.slice(0, 8),
    );
  }
  if (stray && stray.phantoms.length > 0) {
    return mkCheck(
      "node_modules",
      "info",
      `installed — ${stray.phantoms.length} unmanaged top-level package(s), none drifted yet`,
    );
  }
  return mkCheck("node_modules", "ok", "installed");
  });
}

function checkLock(wt: Worktree): Effect.Effect<Check, DoctorCommandError> {
  return syncEffect(() => {
  const info = lockStatus(wt.slug);
  if (!info) return mkCheck("lock", "ok", "none");
  const label = lockLabel(info);
  const pid = info.pid ?? "?";
  const age = lockAge(info);
  const suffix = age ? `, ${age} ago` : "";
  return mkCheck("lock", "warn", `${label} (pid ${pid}${suffix})`);
  });
}

/**
 * A bare `gh pr create` falls back to the REPO DEFAULT BRANCH unless
 * `branch.<name>.gh-merge-base` says otherwise — in a repo whose
 * default branch isn't the integration branch that opens PRs against
 * the wrong base. `wt new` records the config at creation; this catches
 * worktrees created before that, and drift after a reparent (a parent
 * merged and the recorded fork base moved on). Expected = the recorded
 * fork base when one exists (stacked PRs target their parent), else
 * `[branch] base`.
 */
function checkGhMergeBase(wt: Worktree): Effect.Effect<Check, DoctorCommandError> {
  return Effect.gen(function* () {
    if (!wt.branch) return mkCheck("gh merge base", "info", "no branch");
    const expected = readWtState().slugs[wt.slug]?.baseBranch ?? config.branch.base;
    const r = yield* procEffect(["git", "config", `branch.${wt.branch}.gh-merge-base`], { cwd: wt.path });
    const actual = r.exitCode === 0 ? r.stdout.trim() : "";
    if (actual === expected) return mkCheck("gh merge base", "ok", expected);
    return mkCheck(
      "gh merge base", "warn",
      actual ? `set to ${actual}, expected ${expected}` : `unset — a bare \`gh pr create\` targets the repo default branch`,
      [`fix: git -C ${wt.path} config branch.${wt.branch}.gh-merge-base ${expected}`],
    );
  });
}

function checkMerged(wt: Worktree): Effect.Effect<Check, DoctorCommandError> {
  return Effect.gen(function* () {
    if (!wt.branch) return mkCheck("merged", "info", "no branch");
    const trunk = `origin/${config.branch.base}`;
    const merged = yield* branchIsMerged({ slug: wt.slug, branch: wt.branch, path: wt.path }).pipe(
      Effect.mapError((cause) => new DoctorCommandError({ cause })),
    );
    if (merged) return mkCheck("merged", "info", `contained in last-fetched ${trunk}`);
    return mkCheck("merged", "ok", `not in last-fetched ${trunk}`);
  });
}

function checkPr(wt: Worktree): Effect.Effect<Check, DoctorCommandError> {
  return Effect.gen(function* () {
  if (!wt.branch) return mkCheck("pr", "info", "no branch");
  const which = yield* procEffect(["which", "gh"]);
  if (which.exitCode !== 0) return mkCheck("pr", "info", "gh not installed");
  const r = yield* procEffect(["gh", "pr", "view", wt.branch, "--json", "number,state,isDraft,url,statusCheckRollup"], {
    cwd: wt.path,
    timeoutMs: 10_000,
  });
  if (r.exitCode !== 0) return mkCheck("pr", "info", "no PR");
  const data = yield* Effect.try({
    try: () => JSON.parse(r.stdout) as Record<string, unknown>,
    catch: (cause) => new DoctorCommandError({ cause }),
  }).pipe(
    Effect.catch(() => Effect.succeed(null)),
  );
  if (data === null) return mkCheck("pr", "warn", "gh returned non-JSON");
  const state = (data.state as string) || "UNKNOWN";
  const draft = Boolean(data.isDraft);
  const num = data.number;
  const checks = (data.statusCheckRollup as Record<string, string>[] | undefined) ?? [];
  const failed = checks.filter((c) =>
    ["FAILURE", "CANCELLED", "TIMED_OUT"].includes((c.conclusion ?? "").toUpperCase()),
  );
  const pending = checks.filter((c) => ["IN_PROGRESS", "QUEUED"].includes((c.status ?? "").toUpperCase()));
  const parts: string[] = [`#${num}`, state.toLowerCase()];
  if (draft && state === "OPEN") parts.push("(draft)");
  if (failed.length) parts.push(`${failed.length} CI failing`);
  else if (pending.length) parts.push(`${pending.length} CI pending`);
  else parts.push("CI ok");
  let status: CheckStatus = "ok";
  if (failed.length) status = "err";
  else if (pending.length) status = "info";
  else if (state === "MERGED") status = "ok";
  return mkCheck("pr", status, parts.join(" "));
  });
}

/**
 * Machine-level banner: are wt's distributed agent skills/instructions
 * current? Pure fs reads; guarded so a skills-system bug can't break
 * doctor's actual job.
 */
function checkSkillsFreshness(): Effect.Effect<Check, DoctorCommandError> {
  return syncEffect(() => {
    const reports = buildReports(detectTargets(), readSkillsMemory());
    const pending = reports.filter(reportIsActionable);
    if (pending.length === 0) return mkCheck("agent skills", "ok", "up to date");
    const names = [...new Set(pending.map((r) => r.unit.name))];
    return mkCheck("agent skills", "warn", `${names.length} pending (${names.join(", ")}) — run \`wt skills sync\``);
  }).pipe(Effect.catch(() => Effect.succeed(mkCheck("agent skills", "info", "check skipped (skills system errored)"))));
}

/**
 * Machine-level banner: can wt still deliver messages by submitting at
 * a session's own prompt, or has it degraded to typing into panes?
 *
 * Two different failures, both silent without this. A session with no
 * inspector socket was started outside wt (or before wt started opening
 * one) — it still receives messages, typed, losing draft preservation
 * and slash commands. A session whose selftest fails while its socket
 * is fine means Claude Code moved the structural anchors the injector
 * walks, which degrades the WHOLE fleet at once and is exactly the kind
 * of regression an update ships quietly.
 *
 * One selftest, not one per session: the anchors are a property of the
 * Claude Code build, so the first live session answers for all of them.
 */
function checkMessageTransport(): Effect.Effect<Check, DoctorCommandError> {
  return Effect.gen(function* () {
    const entries = [...(yield* listSessions()).claude];
    if (entries.length === 0) return mkCheck("messaging", "ok", "no live claude sessions");
    const names = entries.map((e) => claudeTmuxName(e.slug, e.name));
    // Probe every session, not a representative one: a socket FILE
    // proves nothing (a restarted session leaves a stale one behind),
    // so reporting "working across N" off a single probe would vouch
    // for sessions never connected to.
    const probes = yield* Effect.all(
      names.map((name) => claudeInjectSelftest(name).pipe(Effect.map((probe) => ({ name, probe })))),
      { concurrency: "unbounded" },
    );
    const bad = probes.filter((p) => !p.probe.ok);
    if (bad.length === 0) {
      return mkCheck("messaging", "ok", `prompt injection working across ${names.length} sessions`);
    }
    // Machine-level causes first: they explain 100% of sessions, and
    // every per-session remedy below is wasted breath while one holds.
    // A leftover shim strips BUN_INSPECT at launch, so a fresh session
    // fails exactly like an old one and "restart them from wt" — what
    // this check used to say unconditionally — is guaranteed not to
    // work. That is not a hypothetical: it went unnoticed for a day
    // because "6 of 6" was reported as six per-session problems.
    const stale = staleShims();
    if (stale.length > 0) {
      return mkCheck(
        "messaging",
        "err",
        `no session can bind an inspector socket: a stale ${stale.join(", ")} shim in ${shimDir()} strips BUN_INSPECT at launch — delete it (wt regenerates this directory on the next session spawn). Restarting sessions will not help.`,
      );
    }
    // An anchor break is a property of the Claude Code build, so it
    // takes out EVERY session at once; a restart-shaped failure hits
    // individual ones. Distinguishing them is the whole diagnostic
    // value here, and blaming the anchors for one stale socket would
    // send the reader to rewrite the injector for nothing.
    const kinds = new Set(bad.map((p) => (p.probe.ok ? "" : p.probe.kind)));
    if (bad.length === names.length && (kinds.has("not-ready") || kinds.has("failed"))) {
      const first = bad[0]!;
      return mkCheck(
        "messaging",
        "err",
        `prompt injection failed on all ${names.length} sessions (${first.name}: ${first.probe.ok ? "" : first.probe.reason}) — Claude Code may have moved the injector's anchors; see \`wt claude selftest\``,
      );
    }
    // Only reached with no machine-level cause standing, so a restart
    // is genuinely the remedy — except when it covers EVERY session,
    // where "all of them, independently" is the weaker explanation and
    // saying so beats sending the reader round the restart loop again.
    const all = bad.length === names.length;
    return mkCheck(
      "messaging",
      "warn",
      `${bad.length} of ${names.length} claude sessions are typed at instead (${bad.map((p) => p.name).join(", ")}) — restart them from wt${
        all
          ? ", and if a fresh session still fails, the cause is not per-session: check `wt doctor` again after it starts"
          : ""
      }`,
    );
  });
}

/**
 * Is `wt` reachable as a command, from a SCRIPT?
 *
 * A shell alias satisfies "I can type wt" while failing every
 * non-interactive caller, because aliases don't exist in script files
 * — and wt's own README used to recommend exactly that install. The
 * failure is silent and scales badly: a loop over N worktrees in a .sh
 * file dies with "wt: command not found" partway, leaving the fleet
 * half-updated. It hits manager sessions hardest, since scripting wt
 * across many worktrees IS the job, and it punishes the right instinct
 * (writing a reviewable script instead of a long inline command).
 *
 * `PATH` is resolved manually rather than via `command -v`, because
 * this process's own shell may have the alias and answer misleadingly.
 */
function checkWtOnPath(): Effect.Effect<Check, DoctorCommandError> {
  return syncEffect(() => {
  const launcher = join(import.meta.dir, "..", "..", "..", "bin", "wt");
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, "wt");
    try {
      if (!existsSync(candidate)) continue;
      // Follow the link: a `wt` on PATH belonging to some other install
      // is worse than none, since scripts would silently drive it.
      const real = realpathSync(candidate);
      if (real === realpathSync(launcher)) {
        return mkCheck("wt on PATH", "ok", candidate);
      }
      return mkCheck("wt on PATH", "warn", `${candidate} resolves to ${real}, not this clone's ${launcher}`);
    } catch {
      /* unreadable PATH entry — keep looking */
    }
  }
  const target =
    dirs.find((d) => d === join(homedir(), ".local", "bin")) ??
    dirs.find((d) => d.startsWith(homedir())) ??
    join(homedir(), ".local", "bin");
  // The message carries the fix because this check renders as a BANNER
  // in the common (summary) path, and banners print one line — detail
  // is only seen in the per-worktree report.
  return mkCheck(
    "wt on PATH",
    "warn",
    `not on PATH — scripts can't call \`wt\`; fix: ln -s ${launcher} ${join(target, "wt")}`,
    [
      "a shell alias satisfies interactive use but does not exist inside a",
      "script file, so a .sh looping over worktrees dies partway with",
      "`wt: command not found` and leaves the fleet half-updated.",
    ],
  );
  });
}

function checkMainClone(): Effect.Effect<Check, DoctorCommandError> {
  const main = config.paths.mainClone;
  const base = config.branch.base;
  return procEffect(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], {
    cwd: main,
  }).pipe(Effect.map((r) => {
    if (r.exitCode !== 0) {
    return mkCheck("main clone", "err", `detached HEAD in ${main} — should be on ${base}`);
    }
    const head = r.stdout.trim();
    if (head !== base) {
    return mkCheck(
      "main clone",
      "err",
      `on branch ${JSON.stringify(head)} — should be on ${base}. ` +
        `Move that work into a worktree (\`wt new ${head}\`) and ` +
        `\`git -C ${main} checkout ${base}\`.`,
    );
    }
    return mkCheck("main clone", "ok", `on ${base}`);
  }));
}

function runAllChecks(wt: Worktree, includePr: boolean): Effect.Effect<Check[], DoctorCommandError> {
  const tasks: Effect.Effect<Check, DoctorCommandError>[] = [
    checkWorkingTree(wt),
    checkSync(wt),
    // Gated on the integration, not merely on `.sst/stage` being
    // present: without `[deploy.sst]` there is no stage to pin, so an
    // ungated check warns forever on every row of every setup that
    // doesn't deploy previews — noise that reads as a real problem on
    // the first command a new user runs.
    ...(config.sst ? [checkSstStage(wt), checkSstDeploy(wt)] : []),
    checkNodeModules(wt),
    checkLock(wt),
    checkGhMergeBase(wt),
  ];
  if (includePr) tasks.push(checkPr(wt));
  tasks.push(checkMerged(wt));
  return Effect.all(tasks, { concurrency: "unbounded" });
}

function currentWorktree(wts: Worktree[]): Worktree | null {
  return worktreeAtCwd(wts);
}

function wtToDict(wt: Worktree, checks: Check[]) {
  return {
    slug: wt.slug,
    branch: wt.branch,
    stage: wt.stage,
    path: wt.path,
    overall: worst(checks.map((c) => c.status)),
    checks,
  };
}

/** Machine-level one-liner shown above the per-worktree report, only when noteworthy. */
function renderBanner(c: Check): void {
  if (c.status === "ok") return;
  console.log(`  ${MARKERS[c.status]}  ${bold(c.name.padEnd(14))} ${c.message}`);
}

function reportOne(wt: Worktree, jsonOut: boolean): Effect.Effect<void, DoctorCommandError> {
  return Effect.gen(function* () {
  const [mainBanner, skillsBanner, pathBanner, msgBanner, checks] = yield* Effect.all([
    jsonOut ? Effect.succeed(null) : checkMainClone(),
    jsonOut ? Effect.succeed(null) : checkSkillsFreshness(),
    jsonOut ? Effect.succeed(null) : checkWtOnPath(),
    jsonOut ? Effect.succeed(null) : checkMessageTransport(),
    runAllChecks(wt, true),
  ], { concurrency: "unbounded" });
  if (jsonOut) {
    console.log(JSON.stringify(wtToDict(wt, checks), null, 2));
    return;
  }
  if (mainBanner) renderBanner(mainBanner);
  if (skillsBanner) renderBanner(skillsBanner);
  if (pathBanner) renderBanner(pathBanner);
  if (msgBanner) renderBanner(msgBanner);
  console.log(`${bold("doctor")} · ${cyan(wt.slug)} ${dim(wt.branch)}`);
  for (const c of checks) {
    console.log(`  ${MARKERS[c.status]}  ${bold(c.name.padEnd(14))} ${c.message}`);
    for (const d of c.detail) console.log(`       ${dim(d)}`);
  }
  const overall = worst(checks.map((c) => c.status));
  console.log();
  console.log(`  ${MARKERS[overall]}  overall: ${bold(overall)}`);
  console.log(`     ${dim(`path:  ${wt.path}`)}`);
  // A stage name is computed for every worktree, but it only NAMES
  // anything when `[deploy.sst]` is configured. Printing it otherwise
  // advertises a preview environment that does not exist.
  if (config.sst) console.log(`     ${dim(`stage: ${wt.stage}`)}`);
  });
}

function reportSummary(wts: Worktree[], jsonOut: boolean): Effect.Effect<void, DoctorCommandError> {
  return Effect.gen(function* () {
  const skipPrs = jsonOut;
  const [prs, mainCheck, skillsCheck, pathCheck, msgCheck, allChecks] = yield* Effect.all([
    skipPrs ? Effect.succeed(new Map()) : fetchPrs().pipe(Effect.mapError((cause) => new DoctorCommandError({ cause }))),
    jsonOut ? Effect.succeed(null) : checkMainClone(),
    jsonOut ? Effect.succeed(null) : checkSkillsFreshness(),
    jsonOut ? Effect.succeed(null) : checkWtOnPath(),
    jsonOut ? Effect.succeed(null) : checkMessageTransport(),
    Effect.all(wts.map((w) => runAllChecks(w, false)), { concurrency: "unbounded" }),
  ], { concurrency: "unbounded" });
  if (jsonOut) {
    const out = wts.map((w, i) => wtToDict(w, allChecks[i]!));
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (mainCheck) renderBanner(mainCheck);
  if (skillsCheck) renderBanner(skillsCheck);
  if (pathCheck) renderBanner(pathCheck);
  if (msgCheck) renderBanner(msgCheck);

  type Row = { wt: Worktree; checks: Check[] };
  const rows: Row[] = wts.map((wt, i) => ({ wt, checks: allChecks[i]! }));
  const table = renderTable(rows, [
    { header: "slug", getter: (r) => renderSlugCell((r as Row).wt) },
    ...(config.sst
      ? [
          {
            header: "stage",
            getter: (r: unknown) => renderStageCell((r as Row).wt),
          },
        ]
      : []),
    { header: "pr", getter: (r) => renderPrCell((r as Row).wt, prs) },
    {
      header: "highlights",
      getter: (r) => {
        const note = (r as Row).checks.filter((c) => (c.status === "warn" || c.status === "err") && c.name !== "pr");
        if (!note.length) return dim("all good");
        return note
          .slice(0, 3)
          .map((c) => `${c.name}: ${c.message}`)
          .join(", ");
      },
    },
  ]);
  console.log(table);
  });
}

type Flags = { slug?: string; all: boolean; json: boolean };

function parse(argv: string[]): Flags | { error: string } {
  let slug: string | undefined;
  let all = false;
  let json = false;
  for (const a of argv) {
    if (a === "--all" || a === "-a") all = true;
    else if (a === "--json") json = true;
    else if (a.startsWith("--") || a.startsWith("-")) return { error: `unknown flag: ${a}` };
    else if (!slug) slug = a;
    else return { error: `unexpected arg: ${a}` };
  }
  if (all && slug) return { error: "a slug and --all are mutually exclusive" };
  return { slug, all, json };
}

function runEffectProgram(argv: string[]): Effect.Effect<number, DoctorCommandError> {
  return Effect.gen(function* () {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parse(argv);
  if ("error" in parsed) {
    console.error(red(parsed.error));
    return 2;
  }
  const wtsAll = (yield* listWorktrees().pipe(Effect.mapError((cause) => new DoctorCommandError({ cause })))).filter((w) => !w.isMain);
  if (wtsAll.length === 0) {
    console.log(dim("No worktrees."));
    return 0;
  }
  if (parsed.slug) {
    const target = wtsAll.find((w) => w.slug === parsed.slug);
    if (!target) {
      console.error(red(`No worktree with slug: ${parsed.slug}`));
      return 1;
    }
    yield* reportOne(target, parsed.json);
    return 0;
  }
  const here = parsed.all ? null : currentWorktree(wtsAll);
  if (here) {
    yield* reportOne(here, parsed.json);
    return 0;
  }
  yield* reportSummary(wtsAll, parsed.json);
  return 0;
  });
}

class DoctorCommandError extends Data.TaggedError("DoctorCommandError")<{
  readonly cause: unknown;
}> {}

export function run(argv: string[]): Effect.Effect<number, DoctorCommandError> {
  return runEffectProgram(argv);
}
