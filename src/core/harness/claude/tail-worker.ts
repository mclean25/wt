/**
 * Worker-side session-jsonl tailer. All file watching, byte-offset
 * reads, and JSON parsing for live claude session tails happens here,
 * off the TUI's render/input thread — the same offload the codex
 * events poller got in `codex/events-worker.ts`, for the same reason:
 * a streaming agent writes multi-kilobyte jsonl lines in bursts, and
 * parsing them on the render thread was measurable input latency.
 *
 * Mechanics mirror the old in-registry tailer 1:1 (see `tail.ts` for
 * the lifecycle/seeding/pre-creation-race documentation):
 *  - seed reads the last SEED_TAIL_BYTES and parses forward,
 *  - fs.watch + 80ms debounce coalesces append bursts,
 *  - a shared 3s poll backstops macOS fs.watch dropping events,
 *  - a dir watcher covers the tmux-live-before-first-write race.
 * The parse state (tool-start map, line ids, byte offset, partial
 * fragment) lives here per tail; the main thread only sees parsed
 * `MessageEmit` deltas via `tail-worker-protocol.ts`.
 */
import {
  type FSWatcher,
  existsSync,
  mkdirSync,
  statSync,
  watch,
} from "node:fs";

import type { ActionLine, MessageEmit, ToolStartMap } from "./events.ts";
import { MAX_BUFFERED_LINES } from "./events.ts";
import {
  detectRefreshTriggers,
  type RefreshTarget,
} from "./refresh-triggers.ts";
import {
  type SessionContextUsage,
  applyEmit,
  parseEntry,
} from "./tail-parse.ts";
import { closeSilent, readFileSlice } from "../../tail-util.ts";
import type {
  TailWorkerMessage,
  TailWorkerResult,
} from "./tail-worker-protocol.ts";

declare var self: Worker;

/** How many trailing bytes of the jsonl to seed from on first ensure. */
const SEED_TAIL_BYTES = 64 * 1024;
/**
 * Hard ceiling on a single delta read. A live delta after the 80ms
 * debounce is tens of KB at most; a gap wildly beyond that means the
 * byte cursor is wrong (a seed that never established one — its
 * internal stat can fail without throwing — or a file swapped back in
 * larger after a rotation reset). Reading it all would mean an
 * unbounded parse and one giant postMessage, so past the ceiling we
 * skip ahead and tail from the end instead — the same trade the seed
 * window itself makes.
 */
const MAX_DELTA_BYTES = 512 * 1024;
/** Coalesce window for fs.watch bursts. */
const READ_DEBOUNCE_MS = 80;
/** Polling backstop for fs.watch silently missing appends on macOS. */
const POLL_INTERVAL_MS = 3_000;

type State = {
  slug: string;
  name: string | null;
  /** Echoed on every result — see the protocol's `gen` doc. */
  gen: number;
  path: string;
  projectDir: string;
  jsonlName: string;
  toolStarts: ToolStartMap;
  nextLineId: number;
  lastByte: number;
  pending: string;
  watcher: FSWatcher | null;
  dirWatcher: FSWatcher | null;
  debounce: Timer | null;
};

const tails = new Map<string, State>();
let poller: Timer | null = null;

function post(msg: TailWorkerResult): void {
  postMessage(msg);
}

function warn(message: string, key?: string): void {
  post({ type: "warn", message, key });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

self.onmessage = (event: MessageEvent<TailWorkerMessage>) => {
  const msg = event.data;
  if (msg.type === "ensure") {
    ensure(msg);
    return;
  }
  stopByKey(msg.key);
};

function ensure(msg: Extract<TailWorkerMessage, { type: "ensure" }>): void {
  const existing = tails.get(msg.key);
  if (existing) {
    // Already tracking — only restart if the resolved path changed
    // (e.g. a destroy+recreate cycle re-pointed the slug at a
    // different worktree path within the same TUI run). Same path:
    // adopt the caller's generation so its results keep passing the
    // main thread's gen check (a respawned-registry re-ensure lands
    // here).
    if (existing.path === msg.path) {
      existing.gen = msg.gen;
      return;
    }
    stopByKey(msg.key);
  }
  const st: State = {
    slug: msg.slug,
    name: msg.name,
    gen: msg.gen,
    path: msg.path,
    projectDir: msg.projectDir,
    jsonlName: msg.jsonlName,
    toolStarts: new Map(),
    nextLineId: 1,
    lastByte: 0,
    pending: "",
    watcher: null,
    dirWatcher: null,
    debounce: null,
  };
  tails.set(msg.key, st);
  if (existsSync(st.path)) {
    seedAndWatch(msg.key);
  } else {
    watchForCreation(msg.key);
  }
  ensurePoller();
}

function stopByKey(key: string): void {
  const st = tails.get(key);
  if (!st) return;
  closeSilent(st.watcher);
  closeSilent(st.dirWatcher);
  if (st.debounce) clearTimeout(st.debounce);
  tails.delete(key);
  if (tails.size === 0) stopPoller();
}

function ensurePoller(): void {
  if (poller) return;
  poller = setInterval(() => {
    for (const [key, st] of tails) {
      // Skip tails still in `watchForCreation` mode — the dirWatcher
      // promotes them to `seedAndWatch` when the file appears, and a
      // pre-seed `readDelta` would race the seed's drop-first-partial
      // logic and duplicate content.
      if (st.watcher == null) continue;
      scheduleRead(key);
    }
  }, POLL_INTERVAL_MS);
}

function stopPoller(): void {
  if (!poller) return;
  clearInterval(poller);
  poller = null;
}

function watchForCreation(key: string): void {
  const st = tails.get(key);
  if (!st) return;
  // Project dir may not exist if claude has never written for this
  // worktree before; create it so fs.watch has something to attach to.
  try {
    mkdirSync(st.projectDir, { recursive: true });
  } catch {
    // best-effort; if mkdir fails the watch will too and we warn below
  }
  try {
    st.dirWatcher = watch(
      st.projectDir,
      { persistent: false },
      (_event, filename) => {
        // macOS reports `filename` as null on some atomic-write paths;
        // accept null (recheck) rather than dropping the event.
        if (filename != null && filename !== st.jsonlName) return;
        if (!existsSync(st.path)) return;
        closeSilent(st.dirWatcher);
        st.dirWatcher = null;
        seedAndWatch(key);
      },
    );
  } catch (err) {
    warn(`dir watch failed: ${errMsg(err)}`, key);
    return;
  }
  // Race close: claude can create the file between our pre-watch
  // existsSync (in ensure) and the watcher attaching. Without this
  // recheck the tailer would stay stuck on the dir watcher forever
  // even though the file is on disk and growing.
  if (existsSync(st.path)) {
    closeSilent(st.dirWatcher);
    st.dirWatcher = null;
    seedAndWatch(key);
  }
}

function seedAndWatch(key: string): void {
  const st = tails.get(key);
  if (!st) return;
  try {
    readSeed(key);
  } catch (err) {
    warn(`seed read failed: ${errMsg(err)}`, key);
    // Best-effort skip-ahead: with `lastByte` stuck at 0 the first
    // live delta would read the ENTIRE jsonl from byte 0 — unbounded
    // parse + one giant postMessage — defeating the seed window. Tail
    // from the current size instead; history before this moment is
    // simply not shown (same trade the seed window itself makes).
    try {
      st.lastByte = statSync(st.path).size;
    } catch {
      // File gone — readDelta's own stat will keep failing benignly
      // until (if ever) it reappears.
    }
  }
  try {
    st.watcher = watch(st.path, { persistent: false }, () =>
      scheduleRead(key),
    );
  } catch (err) {
    warn(`file watch failed: ${errMsg(err)}`, key);
  }
}

function readSeed(key: string): void {
  const st = tails.get(key);
  if (!st) return;
  let size = 0;
  try {
    size = statSync(st.path).size;
  } catch {
    return;
  }
  if (size === 0) {
    st.lastByte = 0;
    return;
  }
  const start = Math.max(0, size - SEED_TAIL_BYTES);
  const body = readFileSlice(st.path, start, size - start);
  const lines = body.split("\n");
  // Drop the first fragment if we didn't start at byte 0 — likely partial.
  // Tool_uses outside the seed window leave their tool_results in the
  // window without a matching start in `toolStarts`, so those results
  // render as standalone `→ ok (—)` orphan lines via the orphan path
  // in messageToLines. Acceptable for a seed of bounded size.
  const startIdx = start === 0 ? 0 : 1;
  let accum: ActionLine[] = [];
  // `undefined` = no usage-affecting line seen yet this pass (keep
  // whatever the run already has). A compact_boundary line sets this
  // to `null` (explicit reset); an assistant turn's usage sets it to
  // the parsed figure. Later lines in the forward scan win, matching
  // jsonl order.
  let usage: SessionContextUsage | null | undefined;
  const nextId = () => st.nextLineId++;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const out = parseEntry(line, st.toolStarts, nextId);
    accum = applyEmit(accum, out);
    if (Object.hasOwn(out, "usage")) usage = out.usage;
  }
  st.lastByte = size;
  st.pending = "";
  const trimmed =
    accum.length > MAX_BUFFERED_LINES ? accum.slice(-MAX_BUFFERED_LINES) : accum;
  post({
    type: "seed",
    key,
    gen: st.gen,
    lines: trimmed,
    hasUsage: usage !== undefined,
    usage: usage ?? null,
  });
}

function scheduleRead(key: string): void {
  const st = tails.get(key);
  if (!st) return;
  if (st.debounce) return;
  st.debounce = setTimeout(() => {
    st.debounce = null;
    try {
      readDelta(key);
    } catch (err) {
      warn(`delta read failed: ${errMsg(err)}`, key);
    }
  }, READ_DEBOUNCE_MS);
}

function readDelta(key: string): void {
  const st = tails.get(key);
  if (!st) return;
  let size = 0;
  try {
    size = statSync(st.path).size;
  } catch {
    return;
  }
  if (size === st.lastByte) return;
  if (size < st.lastByte) {
    // File shrank — claude rotated or external truncate. Resync.
    st.lastByte = size;
    st.pending = "";
    return;
  }
  let start = st.lastByte;
  let skippedAhead = false;
  if (size - start > MAX_DELTA_BYTES) {
    start = size - SEED_TAIL_BYTES;
    skippedAhead = true;
    st.pending = "";
  }
  const body = readFileSlice(st.path, start, size - start);
  st.lastByte = size;
  const combined = st.pending + body;
  const lines = combined.split("\n");
  st.pending = lines.pop() ?? "";
  // A skip-ahead lands mid-line; the first fragment is garbage (same
  // drop-first rule as the seed).
  if (skippedAhead) lines.shift();
  const nextId = () => st.nextLineId++;
  const emits: MessageEmit[] = [];
  // See the matching comment in `readSeed`: `undefined` = no signal
  // this batch, `null` = explicit reset (compact_boundary), an object
  // = fresh usage. Last signal in the batch wins.
  let usage: SessionContextUsage | null | undefined;
  const triggers = new Set<RefreshTarget>();
  for (const line of lines) {
    if (!line) continue;
    const out = parseEntry(line, st.toolStarts, nextId);
    if (out.append.length > 0 || out.patch.length > 0) emits.push(out);
    if (Object.hasOwn(out, "usage")) usage = out.usage;
    // Live tail only: scan for `gh pr …` / `git push` &c. `readSeed`
    // deliberately skips this — replaying hours-old history must not
    // fire refreshes.
    for (const target of detectRefreshTriggers(line)) triggers.add(target);
  }
  // A delta posts even with no visible emits: the jsonl grew, and the
  // main thread turns that into the per-slug claude-query refresh.
  post({
    type: "delta",
    key,
    gen: st.gen,
    slug: st.slug,
    emits,
    hasUsage: usage !== undefined,
    usage: usage ?? null,
    triggers: [...triggers],
  });
}
