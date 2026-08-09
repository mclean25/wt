import { formatPerfReport, samplePerf } from "../../core/perf.ts";
import { firstUnknownFlag, hasHelpFlag } from "../args.ts";
import { red } from "../colors.ts";

const USAGE = `usage: wt perf [--json]

One-shot perf snapshot framed as wt-downstream vs the rest of the
machine: verdict numbers, per-category and per-worktree-session
breakdowns, the heaviest processes on both sides, and any leaked
headless wt instances. The default output is the same plain-text
report the TUI's \`P\` overlay injects as an investigation prompt —
hand it to an agent as-is.

  --json    raw PerfSnapshot as JSON (fields documented in
            src/core/perf/sample.ts)

%CPU comes from \`ps\` — a lifetime decaying average, i.e. sustained
pressure, not an instantaneous profile.`;

const KNOWN = new Set(["--json"]);

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
  // Unlike the overlay (where the TUI is `process.pid`), this one-shot
  // process is nobody's ancestor — root at live wt instances too.
  const snap = await samplePerf(undefined, { rootAtWtInstances: true });
  console.log(
    argv.includes("--json")
      ? JSON.stringify(snap, null, 2)
      : formatPerfReport(snap),
  );
  return 0;
}
