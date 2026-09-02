/**
 * `wt update` — fast-forward the wt source clone — plus the pre-TUI
 * startup prompt (`startupUpdatePromptEffect`, wired in main.ts the same way
 * as the skills check). The git/decision machinery lives in
 * core/update.ts (config-free — see the barrel comment); this file is
 * presentation and consent.
 */
import { Cause, Effect } from "effect";

import {
  applyWtUpdateEffect,
  fetchWtOriginEffect,
  findNewestEligibleEffect,
  listRunningWtInstancesEffect,
  logSafe,
  pendingCommitsEffect,
  readUpdateMemory,
  recordUpdateApplied,
  rememberUpdateCheck,
  rememberUpdateDecline,
  restartEventsDaemonAfterUpdateEffect,
  repoUpdateStateEffect,
  selectOffer,
  shortSha,
  startupCheckGate,
  wtVersion,
  WT_REPO_ROOT,
  type GateResult,
  type PendingCommit,
  type RepoUpdateState,
} from "../../core/update.ts";
import { firstUnknownFlag, hasHelpFlag } from "../args.ts";
import { bold, cyan, dim, green, red, yellow } from "../colors.ts";
import { confirmEffect, isInteractive } from "../prompt.ts";

const USAGE = `usage: wt update [log] [--check] [--head]

Update wt itself. The install is a git clone, so this fast-forwards it
(git fetch + merge --ff-only), runs \`bun install\` when the dependency
manifest changed, and boot-probes the result — a version that fails the
probe is reverted and skipped. Targets the newest commit whose CI is
green (unrelated or missing checks don't block); refuses to touch a
clone with local changes or unpushed commits.

  log       print the update/rollback journal (see also: wt rollback)
  --check   only report whether an update is available; don't apply
  --head    ignore the CI gate and target origin's tip

The TUI also checks once a day at startup and prompts y/n (a "no" is
remembered until the offered version changes). \`[update]
startup_check = false\` disables that check; WT_UPDATE=off disables the
whole update system for one run.`;

const KNOWN = new Set(["--check", "--head"]);

/** Print the incoming commits, capped so a long-neglected clone stays readable. */
function printCommits(commits: PendingCommit[]): void {
  const CAP = 20;
  for (const c of commits.slice(0, CAP)) console.log(dim(`  ${shortSha(c.sha)} ${c.subject}`));
  if (commits.length > CAP) console.log(dim(`  … and ${commits.length - CAP} more`));
}

const noteRunningInstances = Effect.gen(function* () {
  const pids = yield* listRunningWtInstancesEffect;
  if (pids.length > 0) {
    console.log(
      yellow(
        `${pids.length} running wt instance(s) (pid ${pids.join(", ")}) still on the old code — restart them to pick this up`,
      ),
    );
  }
});

function describeGateHoldback(gate: GateResult): string {
  const parts = gate.checked
    .filter((c) => c.status === "red" || c.status === "pending")
    .map((c) => `${shortSha(c.sha)} (CI ${c.status === "red" ? "failing" : "running"})`);
  return parts.join(", ");
}

/**
 * Honesty line for a fail-open pick: "unknown" can mean pre-CI history
 * OR an unreachable/rate-limited API, and silently presenting either
 * as if CI vetted it would let a network problem defeat the gate
 * unnoticed.
 */
function gateCaveat(gate: GateResult, target: string): string | null {
  if (!gate.gated) return null;
  const status = gate.checked.find((c) => c.sha === target)?.status;
  return status === "unknown"
    ? `(CI status for ${shortSha(target)} couldn't be verified — the gate fails open)`
    : null;
}

/**
 * Fetch + gate + decide, shared by the command and the startup prompt.
 * Stamps the daily check BEFORE fetching (one attempt per day even
 * when offline). Null = fetch failed.
 */
function fetchAndSelectEffect(useGate: boolean): Effect.Effect<
  | { fresh: RepoUpdateState; gate: GateResult; decision: ReturnType<typeof selectOffer>; commits: PendingCommit[] }
  | null
> {
  return Effect.gen(function* () {
    yield* Effect.sync(() => rememberUpdateCheck(Date.now()));
    if (!(yield* fetchWtOriginEffect)) return null;
    const fresh = yield* repoUpdateStateEffect;
    if (!fresh) return null;
    const commits = fresh.behind > 0 ? yield* pendingCommitsEffect() : [];
    const gate: GateResult = useGate
      ? yield* findNewestEligibleEffect(commits.map((c) => c.sha))
      : { target: commits[0]?.sha ?? null, checked: [], gated: false };
    const decision = selectOffer({
      behind: fresh.behind,
      target: gate.target,
      declinedSha: readUpdateMemory().declinedSha,
    });
    return { fresh, gate, decision, commits };
  });
}

/** Commits from HEAD up to and including `target` (they're what an update to `target` applies). */
function commitsUpTo(commits: PendingCommit[], target: string): PendingCommit[] {
  const idx = commits.findIndex((c) => c.sha === target);
  return idx === -1 ? commits : commits.slice(idx);
}

const runLog: Effect.Effect<number> = Effect.gen(function* () {
  const mem = readUpdateMemory();
  const state = yield* repoUpdateStateEffect;
  const head = state?.headSha ?? null;
  console.log(
    `current ${head ? shortSha(head) : "?"} · last good boot ${mem.lastGoodSha ? shortSha(mem.lastGoodSha) : dim("none recorded")}${
      mem.declinedSha ? ` · skipping ${shortSha(mem.declinedSha)}` : ""
    }`,
  );
  if (mem.journal.length === 0) {
    console.log(dim("no updates or rollbacks recorded yet"));
    return 0;
  }
  for (const e of [...mem.journal].reverse()) {
    // Local wall-clock time, matching the app's other history displays.
    const when = new Date(e.at).toLocaleString();
    const kind = e.kind === "rollback" ? yellow("rollback") : "update  ";
    console.log(`  ${dim(when)}  ${kind}  ${shortSha(e.fromSha)} → ${shortSha(e.toSha)}`);
  }
  return 0;
});

export function run(argv: string[]): Effect.Effect<number> {
  return Effect.gen(function* () {
    if (hasHelpFlag(argv)) {
      console.log(USAGE);
      return 0;
    }
    const positional = argv.filter((a) => !a.startsWith("-"));
    if (positional[0] === "log") return yield* runLog;
    if (positional.length > 0) {
      console.error(red(`unknown argument: ${positional[0]}\n`));
      console.error(USAGE);
      return 2;
    }
    const unknown = firstUnknownFlag(argv, KNOWN);
    if (unknown) {
      console.error(red(`unknown flag: ${unknown}\n`));
      console.error(USAGE);
      return 2;
    }
    const checkOnly = argv.includes("--check");

    const state = yield* repoUpdateStateEffect;
    if (!state) {
      console.error(
        red(`${WT_REPO_ROOT} is not a git checkout (or git is missing) — can't update`),
      );
      return 1;
    }
    if (state.upstream === null) {
      console.error(yellow("HEAD has no upstream — nothing to compare against; update by hand"));
      return 1;
    }
    if (state.dirty || state.ahead > 0) {
      const why = [
        state.dirty ? "local changes" : null,
        state.ahead > 0 ? `${state.ahead} commit(s) ahead of ${state.upstream}` : null,
      ]
        .filter(Boolean)
        .join(" and ");
      console.error(
        yellow(`the wt clone has ${why} — refusing to touch it; update by hand with git`),
      );
      return 1;
    }

    console.log(dim(`fetching ${state.upstream.split("/")[0]} …`));
    const sel = yield* fetchAndSelectEffect(!argv.includes("--head"));
    if (!sel) {
      console.error(red("git fetch failed (offline? auth?) — see the app log"));
      return 1;
    }
    const { fresh, gate, decision, commits } = sel;

    if (decision.action === "up-to-date") {
      console.log(green(`✓ wt is up to date — ${wtVersion()}`));
      return 0;
    }
    if (decision.action === "none-eligible") {
      console.log(
        yellow(
          `${fresh.behind} commit(s) available but held back: ${describeGateHoldback(gate)}`,
        ),
      );
      if (commits.length > gate.checked.length) {
        console.log(
          dim(`(only the newest ${gate.checked.length} of ${commits.length} were checked)`),
        );
      }
      console.log(
        dim("retry once CI is green, or take the tip anyway with `wt update --head`"),
      );
      return 0;
    }
    // An explicit `wt update` overrides a remembered decline — the
    // decline only silences the daily startup offer.
    const target = decision.target;
    const applying = commitsUpTo(commits, target);
    const skipped = commits.length - applying.length;
    console.log(
      bold(
        `update available: ${applying.length} commit(s) (${shortSha(fresh.headSha)} → ${shortSha(target)})`,
      ),
    );
    printCommits(applying);
    const caveat = gateCaveat(gate, target);
    if (caveat) console.log(dim(caveat));
    if (skipped > 0) {
      console.log(dim(`(holding back ${skipped} newer: ${describeGateHoldback(gate)})`));
    }
    if (checkOnly) {
      console.log(dim("run `wt update` to apply"));
      return 0;
    }

    const before = wtVersion();
    const result = yield* applyWtUpdateEffect(target);
    if (!result.ok) {
      if (result.stage === "smoke") {
        rememberUpdateDecline(target);
        console.error(
          red(
            `✗ ${shortSha(target)} failed its boot probe${result.reverted ? " — reverted, staying on the current version" : ""}`,
          ),
        );
        console.error(dim(result.detail));
        if (result.depsRestoreWarning) {
          console.error(yellow(`⚠ ${result.depsRestoreWarning}`));
        }
        console.error(dim("the version is skipped; new origin commits will be offered normally"));
        return 1;
      }
      console.error(
        red(result.stage === "lock" ? result.detail : `fast-forward failed: ${result.detail}`),
      );
      return 1;
    }
    recordUpdateApplied({ now: Date.now(), fromSha: fresh.headSha, toSha: target });
    if (result.installedDeps) console.log(dim("dependencies changed — ran bun install"));
    if (result.depsWarning) console.error(yellow(`⚠ ${result.depsWarning}`));
    console.log(green(`✓ updated ${before} → ${wtVersion()}`));
    yield* noteRunningInstances;
    return result.depsWarning ? 1 : 0;
  });
}

/**
 * Pre-TUI startup check (main.ts). Same posture as the skills prompt:
 * interactive terminals only, silent when there is nothing to offer,
 * and never blocks the TUI on a bug here — unexpected errors are
 * logged and swallowed. Local divergence (dirty/ahead/no upstream)
 * skips silently; the fetch+prompt runs at most once a day; a "no" is
 * remembered per offered version; a smoke-probe failure reverts and
 * declines the bad version automatically.
 *
 * Returns "updated" when a pull was accepted and applied — the caller
 * must then re-exec instead of continuing: main.ts and core/config.ts
 * are already loaded from the OLD code, and lazily-imported TUI
 * modules would come from the new checkout. One process must never
 * run that mix.
 */
export function startupUpdatePromptEffect(): Effect.Effect<"updated" | null> {
  if (!isInteractive()) return Effect.succeed(null);
  return Effect.gen(function* () {
    const state = yield* repoUpdateStateEffect;
    if (!state) return null;
    if (startupCheckGate(state, readUpdateMemory(), Date.now()) !== "run") return null;
    const sel = yield* fetchAndSelectEffect(true);
    if (!sel || sel.decision.action !== "offer") return null;
    const target = sel.decision.target;
    const applying = commitsUpTo(sel.commits, target);

    console.log(
      bold(`wt update available: ${applying.length} new commit(s) (${shortSha(sel.fresh.headSha)} → ${shortSha(target)})`),
    );
    printCommits(applying);
    const caveat = gateCaveat(sel.gate, target);
    if (caveat) console.log(dim(caveat));
    console.log(
      dim('(a "no" is remembered for this version; [update] startup_check = false disables this check)'),
    );
    if (!(yield* confirmEffect(`${cyan("•")} Update now?`, true))) {
      rememberUpdateDecline(target);
      console.log(dim("  skipped (won't ask again until new commits land)"));
      return null;
    }
    const result = yield* applyWtUpdateEffect(target);
    if (!result.ok) {
      if (result.stage === "smoke") {
        rememberUpdateDecline(target);
        console.error(
          red(`✗ ${shortSha(target)} failed its boot probe${result.reverted ? " — reverted" : ""}; starting on the current version`),
        );
        console.error(dim(result.detail));
        if (result.depsRestoreWarning) console.error(yellow(`⚠ ${result.depsRestoreWarning}`));
      } else {
        console.error(red(`${result.stage === "lock" ? result.detail : `fast-forward failed: ${result.detail}`} — starting on the current version`));
      }
      return null;
    }
    recordUpdateApplied({ now: Date.now(), fromSha: sel.fresh.headSha, toSha: target });
    if (result.depsWarning) console.error(yellow(`⚠ ${result.depsWarning}`));
    console.log(green(`✓ updated to ${wtVersion()}`));
    const daemon = yield* restartEventsDaemonAfterUpdateEffect();
    if (daemon.status === "restarted") {
      console.log(dim("  restarted the events daemon on the new build"));
    } else if (daemon.status === "failed") {
      console.error(yellow(`⚠ events daemon restart failed (${daemon.detail}); starting wt anyway`));
    }
    return "updated" as const;
  }).pipe(Effect.catchAllCause((cause) => Effect.sync(() => {
    logSafe("error", Cause.pretty(cause));
    console.error(dim("wt: update check failed (see app log); starting anyway"));
    return null;
  })));
}
