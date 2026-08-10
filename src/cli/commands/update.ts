/**
 * `wt update` — fast-forward the wt source clone — plus the pre-TUI
 * startup prompt (`startupUpdatePrompt`, wired in main.ts the same way
 * as the skills check). The git/decision machinery lives in
 * core/update.ts; this file is presentation and consent.
 */
import {
  applyWtUpdate,
  fetchWtOrigin,
  listRunningWtInstances,
  pendingCommitLines,
  postFetchAction,
  readUpdateMemory,
  rememberUpdateApplied,
  rememberUpdateCheck,
  rememberUpdateDecline,
  repoUpdateState,
  startupCheckGate,
  wtVersion,
  WT_REPO_ROOT,
} from "../../core/update.ts";
import { createLogger } from "../../core/logger.ts";
import { firstUnknownFlag, hasHelpFlag } from "../args.ts";
import { bold, cyan, dim, green, red, yellow } from "../colors.ts";
import { confirm as askYesNo, isInteractive } from "../prompt.ts";

const log = createLogger("[update]");

const USAGE = `usage: wt update [--check]

Update wt itself. The install is a git clone, so this fast-forwards it
(git fetch + merge --ff-only) and runs \`bun install\` when the
dependency manifest changed. Refuses to touch a clone with local
changes or unpushed commits — update those by hand with git.

  --check   only report whether an update is available; don't apply

The TUI also checks once a day at startup and prompts y/n (a "no" is
remembered until origin moves again). \`[update] startup_check = false\`
disables that check; WT_UPDATE=off disables it for one run.`;

const KNOWN = new Set(["--check"]);

/** Print the incoming commits, capped so a long-neglected clone stays readable. */
async function printPendingCommits(): Promise<void> {
  const lines = await pendingCommitLines();
  const CAP = 20;
  for (const line of lines.slice(0, CAP)) console.log(dim(`  ${line}`));
  if (lines.length > CAP) console.log(dim(`  … and ${lines.length - CAP} more`));
}

async function noteRunningInstances(): Promise<void> {
  const pids = await listRunningWtInstances();
  if (pids.length > 0) {
    console.log(
      yellow(
        `${pids.length} running wt instance(s) (pid ${pids.join(", ")}) still on the old code — restart them to pick this up`,
      ),
    );
  }
}

export async function run(argv: string[]): Promise<number> {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const unknown = firstUnknownFlag(argv, KNOWN);
  if (unknown) {
    console.error(red(`unknown flag: ${unknown}\n`));
    console.error(USAGE);
    return 2;
  }
  const checkOnly = argv.includes("--check");

  const state = await repoUpdateState();
  if (!state) {
    console.error(red(`${WT_REPO_ROOT} is not a git checkout (or git is missing) — can't update`));
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
    console.error(yellow(`the wt clone has ${why} — refusing to touch it; update by hand with git`));
    return 1;
  }

  console.log(dim(`fetching ${state.upstream.split("/")[0]} …`));
  if (!(await fetchWtOrigin())) {
    console.error(red("git fetch failed (offline? auth?) — see the app log"));
    return 1;
  }
  rememberUpdateCheck(Date.now());

  const fresh = await repoUpdateState();
  if (!fresh || fresh.behind === 0) {
    console.log(green(`✓ wt is up to date — ${wtVersion()}`));
    return 0;
  }

  console.log(
    bold(`update available: ${fresh.behind} commit(s) (${fresh.headSha} → ${fresh.remoteSha})`),
  );
  await printPendingCommits();
  if (checkOnly) {
    console.log(dim("run `wt update` to apply"));
    return 0;
  }

  const before = wtVersion();
  const result = await applyWtUpdate();
  if (!result.ok) {
    console.error(red(`fast-forward failed: ${result.detail}`));
    return 1;
  }
  rememberUpdateApplied(Date.now());
  if (result.installedDeps) console.log(dim("dependencies changed — ran bun install"));
  if (result.depsWarning) console.error(yellow(`⚠ ${result.depsWarning}`));
  console.log(green(`✓ updated ${before} → ${wtVersion()}`));
  await noteRunningInstances();
  return result.depsWarning ? 1 : 0;
}

/**
 * Pre-TUI startup check (main.ts). Same posture as the skills prompt:
 * interactive terminals only, silent when there is nothing to offer,
 * and never blocks the TUI on a bug here — unexpected errors are
 * logged and swallowed. Local divergence (dirty/ahead/no upstream)
 * skips silently; the fetch+prompt runs at most once a day; a "no" is
 * remembered per remote head.
 *
 * Returns "updated" when a pull was accepted and applied — the caller
 * must then re-exec instead of continuing: main.ts and core/config.ts
 * are already loaded from the OLD code, and lazily-imported TUI
 * modules would come from the new checkout. One process must never
 * run that mix.
 */
export async function startupUpdatePrompt(): Promise<"updated" | null> {
  if (!isInteractive()) return null;
  try {
    const state = await repoUpdateState();
    if (!state) return null;
    if (startupCheckGate(state, readUpdateMemory(), Date.now()) !== "run") return null;
    // Stamp before fetching — one attempt per day even when offline.
    rememberUpdateCheck(Date.now());
    if (!(await fetchWtOrigin())) return null;
    const fresh = await repoUpdateState();
    if (!fresh) return null;
    if (postFetchAction(fresh, readUpdateMemory()) !== "offer") return null;

    console.log(
      bold(`wt update available: ${fresh.behind} new commit(s) (${fresh.headSha} → ${fresh.remoteSha})`),
    );
    await printPendingCommits();
    console.log(
      dim('(a "no" is remembered for this version; [update] startup_check = false disables this check)'),
    );
    if (!(await askYesNo(`${cyan("•")} Update now?`, true))) {
      rememberUpdateDecline(fresh.remoteSha);
      console.log(dim("  skipped (won't ask again until new commits land)"));
      return null;
    }
    const result = await applyWtUpdate();
    if (!result.ok) {
      console.error(red(`fast-forward failed: ${result.detail} — starting on the current version`));
      return null;
    }
    rememberUpdateApplied(Date.now());
    if (result.depsWarning) console.error(yellow(`⚠ ${result.depsWarning}`));
    console.log(green(`✓ updated to ${wtVersion()}`));
    return "updated";
  } catch (err) {
    log.error(err instanceof Error ? err : String(err));
    console.error(dim("wt: update check failed (see app log); starting anyway"));
    return null;
  }
}
