/**
 * `wt status` — show or assert a worktree's work status (the
 * agent-declared lifecycle state; see core/work-status.ts).
 *
 * This command's primary caller is a coding AGENT inside a worktree,
 * not a human — so its output deliberately teaches: every transition
 * prints a short targeted guidance footer (ownership reminders, the
 * next expected step), bare `wt status` prints the vocabulary, and
 * errors restate the rules. Humans mostly use the TUI (`u` picker)
 * and never see this. `WT_NO_HINTS=1` silences the footers.
 */
import { revParse } from "../../core/git.ts";
import { createLogger } from "../../core/logger.ts";
import type { Worktree } from "../../core/types.ts";
import {
  resolveWorkState,
  WORK_RISKS,
  workAge,
  type WorkRisk,
  type WorkState,
  type WorkStatusRecord,
} from "../../core/work-status.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { readWtState, setSlugWorkStatus } from "../../core/wtstate.ts";
import { bold, cyan, dim, green, magenta, red, yellow } from "../colors.ts";

const VOCAB = `states (set with ${bold("wt status <state> [-m note] [--risk r]")}; unique prefixes + nh/nt work):
  ${bold("todo")}           created, not started
  ${bold("working")}        implementation in progress
  ${bold("review")}         under review (self-review / review bot / addressing findings)
  ${bold("needs-testing")}  built; manual verification pending — YOU own that testing
                 (dev env + browser), it is not a request for a human
  ${bold("needs-human")}    blocked on Michael; ${bold("-m")} required: say exactly what you need
  ${bold("ready")}          tested & safe to merge; requires ${bold("--risk low|medium|high")}.
                 medium/high require ${bold("-m")} naming the notable impacts (end
                 users, coworker workflows, costs). High-value only — no noise.

show:  wt status [<slug>] [--all [--json]]     clear: wt status --clear [<slug>]`;

const HINTS_OFF = process.env.WT_NO_HINTS === "1";

/**
 * Per-transition guidance. The convention lives HERE, in the tool the
 * agent already has in hand, so it can't drift from skills that may or
 * may not be loaded. Terse on purpose: 1-3 lines, next step only.
 */
function guidance(state: WorkState): string[] {
  switch (state) {
    case "todo":
      return [`when you pick this up: ${bold("wt status working")}`];
    case "working":
      return [
        `when implementation is done, keep going: review it, test it yourself on the dev env,`,
        `then ${bold("wt status ready --risk <r>")}. Blocked on Michael? ${bold('wt status needs-human -m "<what you need>"')}`,
      ];
    case "review":
      return [
        `after review passes, run the manual/browser testing YOURSELF (dev env), then`,
        `${bold("wt status ready --risk <r> [-m <notable impacts>]")} — or ${bold("needs-testing")} while verification is pending`,
      ];
    case "needs-testing":
      return [
        `you own this testing — drive the dev env/browser yourself; escalate with`,
        `${bold('needs-human -m "..."')} ONLY if blocked on login/creds or a human-only check.`,
        `when it passes: ${bold("wt status ready --risk <r> [-m <notable impacts>]")}`,
      ];
    case "needs-human":
      return [
        `Michael will see this. Keep making progress on anything not blocked,`,
        `and assert the next status the moment you're unblocked.`,
      ];
    case "ready":
      return [
        `leave the PR ready for Michael to merge — do NOT merge it yourself.`,
        `make sure the PR body reflects the final state of the change.`,
      ];
  }
}

function stateColor(state: WorkState): (s: string) => string {
  switch (state) {
    case "needs-human":
      return red;
    case "needs-testing":
      return yellow;
    case "ready":
      return green;
    case "review":
      return magenta;
    case "working":
      return cyan;
    case "todo":
      return dim;
  }
}

function resolveRisk(input: string): WorkRisk | null {
  const q = input.trim().toLowerCase();
  const matches = WORK_RISKS.filter((r) => r.startsWith(q));
  return q !== "" && matches.length === 1 ? matches[0]! : null;
}

async function currentWorktree(all: Worktree[]): Promise<Worktree | null> {
  const cwd = process.cwd();
  return all.find((w) => cwd === w.path || cwd.startsWith(`${w.path}/`)) ?? null;
}

function describe(slug: string, record: WorkStatusRecord | undefined, headSha: string | null): string {
  if (!record) return `${cyan(slug)}  ${dim("no status asserted")}`;
  const color = stateColor(record.state);
  const parts = [`${cyan(slug)}  ${color(record.state)}`];
  if (record.risk) parts.push(dim("risk:") + " " + color(record.risk));
  const age = workAge(record.at);
  if (age) parts.push(dim(`${age} ago`));
  if (record.sha && headSha && record.sha !== headSha) {
    parts.push(yellow("(stale: commits since)"));
  }
  let out = parts.join("  ");
  if (record.note) out += `\n  ${dim("note:")} ${record.note}`;
  return out;
}

function hint(lines: string[]): void {
  if (HINTS_OFF) return;
  for (const line of lines) console.log(dim("» ") + line);
}

export async function run(argv: string[]): Promise<number> {
  const positionals: string[] = [];
  let note: string | null = null;
  let riskRaw: string | null = null;
  let clear = false;
  let all = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-m" || a === "--note") {
      note = argv[++i] ?? null;
      if (note === null) {
        console.error(red(`${a} requires a value`));
        return 2;
      }
    } else if (a === "--risk") {
      riskRaw = argv[++i] ?? null;
      if (riskRaw === null) {
        console.error(red("--risk requires low|medium|high"));
        return 2;
      }
    } else if (a === "--clear") clear = true;
    else if (a === "--all") all = true;
    else if (a === "--json") json = true;
    else if (a === "--help" || a === "-h") {
      console.log(VOCAB);
      return 0;
    } else if (a.startsWith("-")) {
      console.error(red(`unknown flag: ${a}`));
      console.log(VOCAB);
      return 2;
    } else positionals.push(a);
  }

  const wts = (await listWorktrees()).filter((w) => !w.isMain);
  const state = readWtState();

  if (all) {
    const entries = await Promise.all(
      wts.map(async (w) => {
        const record = state.slugs[w.slug]?.work;
        const headSha = await revParse("HEAD", w.path);
        return {
          slug: w.slug,
          branch: w.branch,
          state: record?.state ?? null,
          note: record?.note ?? null,
          risk: record?.risk ?? null,
          at: record?.at ?? null,
          stale: !!(record?.sha && headSha && record.sha !== headSha),
        };
      }),
    );
    if (json) {
      console.log(JSON.stringify(entries, null, 2));
      return 0;
    }
    for (const w of wts) {
      const headSha = await revParse("HEAD", w.path);
      console.log(describe(w.slug, state.slugs[w.slug]?.work, headSha));
    }
    return 0;
  }

  // Positional layout: [] show-cwd · [state] set-on-cwd · [slug] show ·
  // [slug, state] set. A lone positional that resolves to a state wins
  // over slug interpretation (states are reserved words here).
  let target: Worktree | null = null;
  let stateArg: string | null = null;
  if (positionals.length === 0) {
    target = await currentWorktree(wts);
  } else if (positionals.length === 1) {
    const asState = resolveWorkState(positionals[0]!);
    if (asState && !clear) {
      stateArg = positionals[0]!;
      target = await currentWorktree(wts);
    } else {
      target =
        wts.find((w) => w.slug === positionals[0] || w.branch === positionals[0]) ?? null;
      if (!target) {
        console.error(red(`no worktree (and no such status): ${positionals[0]}`));
        console.log(VOCAB);
        return 1;
      }
    }
  } else if (positionals.length === 2) {
    target =
      wts.find((w) => w.slug === positionals[0] || w.branch === positionals[0]) ?? null;
    if (!target) {
      console.error(red(`no worktree: ${positionals[0]}`));
      return 1;
    }
    stateArg = positionals[1]!;
  } else {
    console.error(red(`too many arguments`));
    console.log(VOCAB);
    return 2;
  }

  if (!target) {
    console.error(red("not inside a worktree — pass a slug, or cd into one"));
    return 1;
  }

  if (clear) {
    setSlugWorkStatus(target.slug, null);
    console.log(green(`✓ ${target.slug} status cleared`));
    return 0;
  }

  if (stateArg === null) {
    const headSha = await revParse("HEAD", target.path);
    console.log(describe(target.slug, state.slugs[target.slug]?.work, headSha));
    if (!HINTS_OFF) {
      console.log("");
      console.log(VOCAB);
    }
    return 0;
  }

  const next = resolveWorkState(stateArg);
  if (!next) {
    console.error(red(`unknown status: ${stateArg}`));
    console.log(VOCAB);
    return 2;
  }

  let risk: WorkRisk | null = null;
  if (riskRaw !== null) {
    risk = resolveRisk(riskRaw);
    if (!risk) {
      console.error(red(`--risk must be one of ${WORK_RISKS.join("|")}, got "${riskRaw}"`));
      return 2;
    }
    if (next !== "ready") {
      console.error(red(`--risk only applies to ready (got ${next})`));
      return 2;
    }
  }

  // The rules that make statuses trustworthy. Enforced here (the
  // agent-facing surface); the TUI picker stays lenient for the human.
  if (next === "ready" && !risk) {
    console.error(red("ready requires --risk low|medium|high — how risky is merging this?"));
    hint([
      "judge broadly: end users, coworker workflows/dev tooling, costs, migrations.",
      `medium/high also require ${bold("-m")} naming the notable impacts. No noise: if`,
      `nothing is notable, that's ${bold("--risk low")} with no note.`,
    ]);
    return 2;
  }
  if (next === "ready" && risk !== "low" && !note) {
    console.error(
      red(`ready --risk ${risk} requires -m: what should Michael know before merging?`),
    );
    hint([
      "high-value only — end-user impact, coworker disruption, cost, irreversibility",
      `(e.g. "calendar integrations may need a resync", "not reasonably testable").`,
    ]);
    return 2;
  }
  if (next === "needs-human" && !note) {
    console.error(red('needs-human requires -m: what exactly do you need from Michael?'));
    hint([`e.g. -m "dev-env Google login expired — log me back in via the open browser"`]);
    return 2;
  }

  const record: WorkStatusRecord = {
    state: next,
    at: new Date().toISOString(),
  };
  if (note) record.note = note;
  if (risk) record.risk = risk;
  const sha = await revParse("HEAD", target.path);
  if (sha) record.sha = sha;
  setSlugWorkStatus(target.slug, record);

  // File-only audit trail (the TUI derives its own attention-feed
  // entries from the wtstate change; this line is for `grep EVENT`).
  const log = createLogger(target.slug);
  const detail = `${next}${risk ? ` (risk: ${risk})` : ""}${note ? ` — ${note}` : ""}`;
  log.info(`work status → ${detail}`);

  const color = stateColor(next);
  console.log(`${green("✓")} ${cyan(target.slug)} → ${color(next)}${risk ? `  ${dim("risk:")} ${color(risk)}` : ""}`);
  if (note) console.log(`  ${dim("note:")} ${note}`);
  hint(guidance(next));
  return 0;
}
