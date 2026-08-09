/**
 * Perf sampler backing the `P` overlay — a filtered, wt-scoped `btop`.
 *
 * The question it exists to answer is "the machine feels slow; is that
 * us?", so everything is framed as **wt-downstream vs the rest of the
 * machine**. Downstream means: the wt TUI process, the wt-private tmux
 * server, and every descendant of either. Session attribution comes from
 * tmux's own `pane_pid`, so a process lands under the worktree whose
 * pane spawned it no matter how deep the fork chain got.
 *
 * ## The %CPU caveat
 *
 * `ps` reports a *decaying average* over the process's lifetime, not an
 * instantaneous sample. A long-lived process showing 130% may be idle
 * right now, and a 2-second-old one is barely averaged at all. That is
 * acceptable (arguably preferable) for "is this load reasonable?", which
 * is a question about sustained pressure rather than this instant — but
 * it is NOT a profiler, and the overlay says so. Percentages are
 * core-relative: 100% = one core saturated, so the ceiling is
 * `cores * 100`.
 */
import { cpus, freemem, loadavg, totalmem } from "node:os";

import { createLogger } from "../logger.ts";
import { run } from "../proc.ts";
import { TMUX_SOCKET } from "../tmux.ts";

const log = createLogger("[perf]");

/** How many wt-downstream processes the overlay lists individually. */
const TOP_N = 12;
/** How many non-wt processes to name when answering "is it even us?". */
const OUTSIDER_N = 6;

export type PerfCategory =
  | "harness"
  | "test"
  | "build"
  | "dev"
  | "wt"
  | "tmux"
  | "shell"
  | "other";

/** Display order — roughly "most likely to be the culprit" first. */
export const PERF_CATEGORIES: readonly PerfCategory[] = [
  "harness",
  "test",
  "build",
  "dev",
  "wt",
  "tmux",
  "shell",
  "other",
];

export const CATEGORY_LABEL: Record<PerfCategory, string> = {
  harness: "agents",
  test: "tests",
  build: "typecheck/lint",
  dev: "dev servers",
  wt: "wt itself",
  tmux: "tmux",
  shell: "shells",
  other: "other",
};

export type PerfProc = {
  pid: number;
  ppid: number;
  /** ps %CPU — a lifetime decaying average, not instantaneous. */
  cpu: number;
  rssMb: number;
  /** ps ELAPSED, e.g. `02-20:13:52`. */
  etime: string;
  command: string;
  category: PerfCategory;
  /** wt-private tmux session this descends from, when any. */
  session: string | null;
};

export type PerfBucket = {
  category: PerfCategory;
  cpu: number;
  rssMb: number;
  count: number;
};

export type PerfSession = {
  name: string;
  cpu: number;
  rssMb: number;
  count: number;
  /** Category gloss, e.g. `agents + tests×12`. */
  summary: string;
};

export type PerfSnapshot = {
  sampledAt: number;
  cores: number;
  loadAvg: readonly [number, number, number];
  memTotalMb: number;
  memUsedMb: number;
  /** Sum of %cpu across every process on the machine. */
  systemCpu: number;
  /** Sum of %cpu for everything descending from wt or its tmux server. */
  wtCpu: number;
  wtRssMb: number;
  wtProcCount: number;
  categories: PerfBucket[];
  sessions: PerfSession[];
  top: PerfProc[];
  outsiders: PerfProc[];
  /**
   * wt TUI instances reparented to launchd — a terminal died and the
   * process survived. Always a leak (a headless TUI serves nobody):
   * each one keeps polling GitHub and duplicating attention lines.
   * One probe sweep left 33 of these; the overlay exists to make a
   * recurrence visible instead of a mystery CPU tax.
   */
  orphans: PerfProc[];
};

// ── Sampling ───────────────────────────────────────────────────────────

/**
 * `pid ppid %cpu rss etime args`. `args` goes last and soaks up the rest
 * of the line because command lines contain spaces (and on macOS so do
 * some process *names*); every field before it is space-free, `etime`
 * included (`[[dd-]hh:]mm:ss`).
 */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/;

type RawProc = Omit<PerfProc, "category" | "session">;

/** Commands this sampler itself spawns — excluded so a freshly-forked
 *  helper's barely-averaged %CPU doesn't show up as a hotspot. */
const SELF_RE =
  /^ps -Ao pid=|^vm_stat\b|^tmux -L \S+ (list-panes|display-message)\b/;

/**
 * Hard ceiling on any one helper. This overlay is opened *because* the
 * machine is struggling, which is exactly when a fork storm or a wedged
 * tmux server can leave `ps`/`tmux` hanging. Without a bound, one stuck
 * call parks `samplePerf` forever: `refetchInterval` won't fire a
 * replacement while the previous one is in flight, so the overlay
 * freezes on a stale snapshot with no error and no recovery.
 */
const HELPER_TIMEOUT_MS = 4_000;

/**
 * Run a helper and return its stdout lines, or null if it failed.
 *
 * null (not `[]`) on failure is load-bearing: "the tool broke" and "the
 * tool reported nothing" are different answers, and for this overlay
 * conflating them renders a broken sampler as a reassuringly idle
 * machine — the exact opposite of the truth it exists to show.
 */
async function readLines(
  cmd: string[],
  signal?: AbortSignal,
): Promise<string[] | null> {
  const { stdout, exitCode } = await run(cmd, {
    timeoutMs: HELPER_TIMEOUT_MS,
    signal,
  });
  // run() never throws: a missing binary or a timeout surfaces as a
  // negative exit code.
  if (exitCode !== 0) {
    log.debug("perf helper failed", { cmd: cmd[0], exitCode });
    return null;
  }
  return stdout.split("\n");
}

/**
 * Throws when `ps` itself fails, so the query lands in an error state
 * and the overlay can say so. A live system always has processes, so a
 * successful-but-empty parse means the output shape wasn't what we
 * expect (a non-macOS `ps`, say) and is treated as failure too.
 */
async function sampleProcesses(signal?: AbortSignal): Promise<RawProc[]> {
  const lines = await readLines(
    ["ps", "-Ao", "pid=,ppid=,pcpu=,rss=,etime=,args="],
    signal,
  );
  if (lines === null) throw new Error("ps failed — cannot sample processes");
  const rows: RawProc[] = [];
  for (const line of lines) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    const command = m[6]!.trim();
    if (SELF_RE.test(command)) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      cpu: Number(m[3]),
      rssMb: Number(m[4]) / 1024,
      etime: m[5]!,
      command,
    });
  }
  if (rows.length === 0) {
    throw new Error("ps returned no parseable processes");
  }
  return rows;
}

/** pane pid → tmux session name, for the wt-private server. Empty when
 *  the server isn't running (no sessions yet, or it was killed) — that
 *  degrades the overlay to "no sessions", which is honest, rather than
 *  failing the whole snapshot. */
async function tmuxPanePids(signal?: AbortSignal): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  const lines = await readLines(
    [
      "tmux",
      "-L",
      TMUX_SOCKET,
      "list-panes",
      "-a",
      "-F",
      "#{session_name}\t#{pane_pid}",
    ],
    signal,
  );
  for (const line of lines ?? []) {
    const [name, pid] = line.split("\t");
    if (!name || !pid) continue;
    const n = Number(pid);
    if (Number.isFinite(n)) map.set(n, name);
  }
  return map;
}

async function tmuxServerPid(signal?: AbortSignal): Promise<number | null> {
  const lines = await readLines(
    ["tmux", "-L", TMUX_SOCKET, "display-message", "-p", "#{pid}"],
    signal,
  );
  const n = Number((lines?.[0] ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Classification ─────────────────────────────────────────────────────

// Checked in this order; first match wins. `test` deliberately precedes
// `build` so `npm exec vitest run eslint-rules` is a test run, not a
// lint, and `build` precedes `dev` so `vite build` isn't a dev server.
const WT_RE = /\/\.?wt\/(bin|src)\/|(^|\/)wt\s+(ls|new|rm|logs|doctor|status)\b/;
const HARNESS_RE = /(^|\/|\s)(claude|codex|opencode)(\s|$)/;
const TEST_RE = /\b(vitest|jest|playwright)\b|\bdeno\s+test\b/;
const BUILD_RE = /\b(tsc|eslint|biome|esbuild|rollup|webpack|swc|prettier)\b|\bvite\s+build\b/;
const DEV_RE = /\bvite\b|\bnext\s+dev\b|\.cache\/wt\/dev\//;
const TMUX_RE = /(^|\/)tmux(\s|$)/;
const SHELL_RE = /^-?(\/\S+\/)?(zsh|bash|sh|fish)(\s|$)/;

// Package-runner wrappers name a SCRIPT, not a binary: the `pnpm test`
// parent of a vitest tree matches none of the patterns above and would
// land in `other`, under-reporting the category that's actually burning
// the CPU. Matched only after the direct-binary checks so a real binary
// on the line always wins.
const RUNNER = /\b(pnpm|npm|npx|yarn|bun)\b/;
const SCRIPT_TEST_RE = /\b(test|test:edge|test:unit|test:watch)\b/;
const SCRIPT_BUILD_RE = /\b(typecheck|lint|build|format)\b/;
const SCRIPT_DEV_RE = /\b(dev|preview|start|serve)\b/;

/**
 * A wt TUI process whose parent is launchd (ppid 1) lost its terminal
 * and should have exited — SIGHUP handling makes new builds do so, but
 * older builds (and a wedged teardown) survive headless. Matches both
 * launch forms: the bin wrapper (`bun /…/.wt/bin/../src/main.ts`, via
 * WT_RE) and a repo-cwd `bun src/main.ts` (how the probe harness and
 * dev runs start it). The bare relative form could in principle be
 * another project's main.ts — accepted: this feeds a warning list, and
 * a headless orphaned `bun src/main.ts` is a leak whoever owns it.
 */
export function isOrphanedWtInstance(
  p: { pid: number; ppid: number; command: string },
  selfPid: number = process.pid,
): boolean {
  if (p.ppid !== 1 || p.pid === selfPid) return false;
  return WT_RE.test(p.command) || /^bun src\/main\.ts$/.test(p.command);
}

export function classifyProcess(command: string): PerfCategory {
  // Shell FIRST, and only when the shell is argv[0] (SHELL_RE is
  // start-anchored). Every other pattern here matches anywhere on the
  // line, so a wrapper like `zsh -c '... /.wt/src/main.ts ...'` would
  // otherwise be classified by its *payload* — observed in review,
  // where a shell-snapshot wrapper landed in the `wt` bucket. A shell
  // wrapper burns no CPU itself; its children are classified on their
  // own merits, so calling it a shell is both correct and harmless.
  if (SHELL_RE.test(command)) return "shell";
  if (WT_RE.test(command)) return "wt";
  if (HARNESS_RE.test(command)) return "harness";
  if (TEST_RE.test(command)) return "test";
  if (BUILD_RE.test(command)) return "build";
  if (DEV_RE.test(command)) return "dev";
  if (RUNNER.test(command)) {
    if (SCRIPT_TEST_RE.test(command)) return "test";
    if (SCRIPT_BUILD_RE.test(command)) return "build";
    if (SCRIPT_DEV_RE.test(command)) return "dev";
  }
  if (TMUX_RE.test(command)) return "tmux";
  return "other";
}

// ── Memory ─────────────────────────────────────────────────────────────

/**
 * macOS "memory used", Activity-Monitor style: active + wired +
 * compressor-occupied pages.
 *
 * `os.freemem()` is NOT usable here — it reports only genuinely free
 * pages, so on a machine that has been up a while it reads ~90% used
 * essentially always (measured: 29.2 of 32 GB, while macOS itself
 * reported 69% free). A meter pinned to red regardless of load is worse
 * than no meter, since the whole overlay exists to answer "is this
 * reasonable?".
 *
 * Returns null when `vm_stat` isn't parseable; the caller falls back to
 * the `os` numbers rather than dropping the row.
 */
async function macMemoryUsedMb(signal?: AbortSignal): Promise<number | null> {
  const lines = await readLines(["vm_stat"], signal);
  if (lines === null || lines.length === 0) return null;
  const pageSize = Number(/page size of (\d+) bytes/.exec(lines[0] ?? "")?.[1]);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return null;
  const pagesFor = (label: string): number => {
    for (const line of lines) {
      if (!line.startsWith(label)) continue;
      const n = Number(/(\d+)\./.exec(line)?.[1]);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  };
  const pages =
    pagesFor("Pages active") +
    pagesFor("Pages wired down") +
    pagesFor("Pages occupied by compressor");
  if (pages <= 0) return null;
  return (pages * pageSize) / 1024 / 1024;
}

// ── Assembly ───────────────────────────────────────────────────────────

/** pid → direct children, for descendant walks. */
function childIndex(procs: RawProc[]): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  for (const p of procs) {
    const list = kids.get(p.ppid);
    if (list) list.push(p.pid);
    else kids.set(p.ppid, [p.pid]);
  }
  return kids;
}

/**
 * Every pid reachable from `roots`, roots included. Iterative (not
 * recursive) and `seen`-guarded: a pid whose parent exited gets
 * reparented to launchd, and a stale ps snapshot can in principle
 * present a cycle — neither should hang the TUI.
 */
function descendants(roots: number[], kids: Map<number, number[]>): Set<number> {
  const seen = new Set<number>();
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const kid of kids.get(pid) ?? []) {
      if (!seen.has(kid)) stack.push(kid);
    }
  }
  return seen;
}

function bucketize(procs: PerfProc[]): PerfBucket[] {
  const by = new Map<PerfCategory, PerfBucket>();
  for (const p of procs) {
    const b = by.get(p.category) ?? {
      category: p.category,
      cpu: 0,
      rssMb: 0,
      count: 0,
    };
    b.cpu += p.cpu;
    b.rssMb += p.rssMb;
    b.count += 1;
    by.set(p.category, b);
  }
  return PERF_CATEGORIES.map((c) => by.get(c)).filter(
    (b): b is PerfBucket => b !== undefined,
  );
}

/** `agents + tests×12` — the categories present, heaviest CPU first. */
function sessionSummary(procs: PerfProc[]): string {
  return bucketize(procs)
    .slice()
    .sort((a, b) => b.cpu - a.cpu)
    .map((b) => (b.count > 1 ? `${CATEGORY_LABEL[b.category]}×${b.count}` : CATEGORY_LABEL[b.category]))
    .join(" + ");
}

/**
 * Take one sample. Four shell-outs (`ps`, `vm_stat`, tmux `list-panes`,
 * tmux `display-message`) run concurrently; a dead tmux server degrades
 * to "no sessions" rather than failing the snapshot, so the overlay
 * still answers the system-level half of the question.
 */
export async function samplePerf(signal?: AbortSignal): Promise<PerfSnapshot> {
  // The four run concurrently, so they observe slightly different
  // instants. A process that exits in that window can be mis-attributed
  // for exactly one sample (wrong session tag, or landing outside wt's
  // tree); at a 2s cadence it self-corrects on the next tick, which is
  // cheaper than serialising the helpers to get a consistent instant.
  const [procs, panePids, serverPid, memUsedMb] = await Promise.all([
    sampleProcesses(signal),
    tmuxPanePids(signal),
    tmuxServerPid(signal),
    macMemoryUsedMb(signal),
  ]);

  const kids = childIndex(procs);

  // Session attribution first: a pane's whole subtree belongs to it.
  const sessionOf = new Map<number, string>();
  for (const [panePid, name] of panePids) {
    for (const pid of descendants([panePid], kids)) {
      // First writer wins — panes never nest, so this only guards the
      // pathological reparenting case.
      if (!sessionOf.has(pid)) sessionOf.set(pid, name);
    }
  }

  // Downstream = wt's own process tree + the whole tmux server tree.
  const roots = [process.pid, ...(serverPid === null ? [] : [serverPid])];
  const downstream = descendants(roots, kids);

  const mine: PerfProc[] = [];
  const theirs: PerfProc[] = [];
  let systemCpu = 0;
  for (const p of procs) {
    systemCpu += p.cpu;
    const enriched: PerfProc = {
      ...p,
      category: classifyProcess(p.command),
      session: sessionOf.get(p.pid) ?? null,
    };
    if (downstream.has(p.pid)) mine.push(enriched);
    else theirs.push(enriched);
  }

  const bySession = new Map<string, PerfProc[]>();
  for (const p of mine) {
    if (p.session === null) continue;
    const list = bySession.get(p.session);
    if (list) list.push(p);
    else bySession.set(p.session, [p]);
  }

  const sessions: PerfSession[] = [...bySession.entries()]
    .map(([name, list]) => ({
      name,
      cpu: list.reduce((n, p) => n + p.cpu, 0),
      rssMb: list.reduce((n, p) => n + p.rssMb, 0),
      count: list.length,
      summary: sessionSummary(list),
    }))
    .sort((a, b) => b.cpu - a.cpu);

  const [one, five, fifteen] = loadavg();
  const memTotalMb = totalmem() / 1024 / 1024;

  return {
    sampledAt: Date.now(),
    cores: cpus().length,
    loadAvg: [one ?? 0, five ?? 0, fifteen ?? 0] as const,
    memTotalMb,
    memUsedMb: memUsedMb ?? memTotalMb - freemem() / 1024 / 1024,
    systemCpu,
    wtCpu: mine.reduce((n, p) => n + p.cpu, 0),
    wtRssMb: mine.reduce((n, p) => n + p.rssMb, 0),
    wtProcCount: mine.length,
    categories: bucketize(mine).sort((a, b) => b.cpu - a.cpu),
    sessions,
    top: mine.slice().sort((a, b) => b.cpu - a.cpu).slice(0, TOP_N),
    outsiders: theirs.slice().sort((a, b) => b.cpu - a.cpu).slice(0, OUTSIDER_N),
    // Checked against ALL processes: an orphan is by definition outside
    // wt's live descendant tree (its parent is launchd).
    orphans: procs
      .filter((p) => isOrphanedWtInstance(p))
      .map((p) => ({
        ...p,
        category: "wt" as const,
        session: null,
      }))
      .sort((a, b) => b.cpu - a.cpu),
  };
}

// ── Report ─────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${n.toFixed(0)}%`;
}

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`;
}

/** Trim a command line for report/table use — full paths are noise. */
export function shortCommand(command: string, max = 60): string {
  const trimmed = command.replace(/^\/\S+\/(?=[^/\s]+(\s|$))/, "");
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/**
 * Plain-text rendering of a snapshot, for injecting into a harness
 * session. Deliberately not the same layout as the overlay: no bars, no
 * colour, and it states the %CPU caveat inline so the agent reading it
 * doesn't over-trust a decaying average.
 */
export function formatPerfReport(s: PerfSnapshot): string {
  const lines: string[] = [];
  const ceiling = s.cores * 100;
  lines.push(
    `# wt perf snapshot (${new Date(s.sampledAt).toISOString()})`,
    "",
    `Machine: ${s.cores} cores, ${gb(s.memTotalMb)} RAM`,
    `Load average: ${s.loadAvg.map((n) => n.toFixed(2)).join("  ")} (1m/5m/15m)`,
    `Memory in use: ${gb(s.memUsedMb)} / ${gb(s.memTotalMb)}`,
    `CPU: ${pct(s.systemCpu)} of ${pct(ceiling)} machine-wide; ` +
      `${pct(s.wtCpu)} of that is wt-downstream ` +
      `(${s.wtProcCount} procs, ${gb(s.wtRssMb)})`,
    "",
    "NOTE: percentages come from `ps` %CPU, a lifetime decaying average " +
      "rather than an instantaneous sample. Treat them as sustained " +
      "pressure, not a profile.",
    "",
    "## wt-downstream by category",
  );
  for (const b of s.categories) {
    lines.push(
      `- ${CATEGORY_LABEL[b.category]}: ${pct(b.cpu)}, ${gb(b.rssMb)}, ${b.count} proc(s)`,
    );
  }
  if (s.sessions.length > 0) {
    lines.push("", "## By tmux session (worktree)");
    for (const sess of s.sessions) {
      lines.push(
        `- ${sess.name}: ${pct(sess.cpu)}, ${gb(sess.rssMb)}, ${sess.count} procs — ${sess.summary}`,
      );
    }
  }
  lines.push("", "## Heaviest wt-downstream processes");
  for (const p of s.top) {
    lines.push(
      `- ${pct(p.cpu)}  ${gb(p.rssMb)}  [${p.category}]` +
        `${p.session ? ` [${p.session}]` : ""}  ${shortCommand(p.command, 100)}`,
    );
  }
  lines.push("", "## Heaviest processes NOT downstream of wt");
  for (const p of s.outsiders) {
    lines.push(`- ${pct(p.cpu)}  ${gb(p.rssMb)}  ${shortCommand(p.command, 100)}`);
  }
  if (s.orphans.length > 0) {
    lines.push(
      "",
      `## LEAKED: ${s.orphans.length} headless wt instance(s)`,
      "These lost their terminal but never exited (orphaned to launchd).",
      "They poll GitHub and duplicate attention-feed lines until killed:",
      `  kill ${s.orphans.map((p) => p.pid).join(" ")}`,
    );
    for (const p of s.orphans) {
      lines.push(`- pid ${p.pid}  ${pct(p.cpu)}  ${gb(p.rssMb)}  up ${p.etime}`);
    }
  }
  return lines.join("\n");
}

/** The prompt `i` injects: the snapshot plus what to do with it. */
export function buildPerfInvestigationPrompt(s: PerfSnapshot): string {
  return [
    "My machine feels slow and I captured a perf snapshot from wt's `P`",
    "overlay. Work out whether the load is reasonable for what's actually",
    "running, and if it isn't, what to do about it.",
    "",
    "Check the wt-downstream share against the machine total first — if the",
    "heavy processes are outside wt, say so plainly rather than hunting for a",
    "wt/agent explanation. Verify anything load-bearing with your own tool",
    "calls instead of trusting these numbers alone; %CPU here is a decaying",
    "average.",
    "",
    "Do not kill any processes without asking me first.",
    "",
    "---",
    "",
    formatPerfReport(s),
  ].join("\n");
}
