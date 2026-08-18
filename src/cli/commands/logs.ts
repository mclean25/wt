import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { config } from "../../core/config.ts";
import { latestLogFor } from "../../core/logs.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { hasHelpFlag } from "../args.ts";
import { dim, red } from "../colors.ts";

const USAGE = `usage: wt logs [<slug>]

Tail a destroy log (\`tail -F\`). No slug ⇒ the most recently modified
log.`;

/** Newest log across *any* slug — used for `wt logs` with no arg. */
function mostRecentLog(): string | null {
  const dir = config.paths.logDir;
  if (!existsSync(dir)) return null;
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return null;
  }
  const matching = files
    .filter((f) => f.endsWith(".log"))
    .flatMap((f) => {
      // A log can vanish between readdir and stat (startup reap) — skip it.
      try {
        return [{ name: f, mtime: statSync(join(dir, f)).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime);
  return matching[0] ? join(dir, matching[0].name) : null;
}

export async function run(argv: string[]): Promise<number> {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  const slug = argv.find((a) => !a.startsWith("-")) ?? null;

  let logPath: string | null = null;
  if (slug) {
    const wts = await listWorktrees();
    const match = wts.find((w) => w.slug === slug);
    if (match) logPath = latestLogFor(match.slug);
  } else {
    logPath = mostRecentLog();
  }
  if (!logPath) {
    // "No destroy logs found" is true and is almost never the question.
    // This command gets reached by someone whose SESSION misbehaved,
    // for whom a destroy log was never the right artifact — so say what
    // this command covers, and name the two places the other answers
    // live. Both were unfindable when a Claude start failed to
    // register: the reader had a true sentence about the wrong subject
    // and nowhere else to look.
    console.log(dim(slug ? `No destroy logs for ${slug}.` : "No destroy logs found."));
    console.log(
      dim("(destroy logs only — a session's own output is `wt claude ls`"),
    );
    console.log(
      dim(` and its pane; wt's own log is ${join(config.paths.logDir, "app")}/wt-<date>.log)`),
    );
    return 1;
  }
  if (!existsSync(logPath)) {
    console.error(red(`Log file missing: ${logPath}`));
    return 1;
  }
  console.log(dim(`→ ${logPath}`));
  const p = Bun.spawn(["tail", "-n", "200", "-F", logPath], {
    stdout: "inherit",
    stderr: "inherit",
  });
  return (await p.exited) ?? 0;
}
