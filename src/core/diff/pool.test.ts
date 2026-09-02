/**
 * `pool.ts`'s Worker pool had zero tests for its concurrency contract —
 * cancellation, per-worker death isolation, and dispose-rejects-all —
 * despite carrying module-lifetime state (`workers`, `pending`,
 * `disposed`) that a `bun test` process never gets back once spent
 * (`disposed` has no reset). Each scenario therefore runs in its own
 * subprocess (mirroring `fetch-origin.test.ts`'s pattern for the same
 * problem) rather than trying to re-import a "fresh" `pool.ts` in this
 * process — verified against this Bun that a query-busted dynamic
 * `import()` of a relative `.ts` module does NOT get a fresh module
 * instance (module identity and top-level state both survive), so
 * anything short of a new process shares the one real pool forever,
 * including with whatever else `bun test`'s single process imports it.
 *
 * A fake `Worker` (a "tiny real worker" stand-in, per the brief) is
 * monkeypatched onto the subprocess's `globalThis` before `pool.ts` is
 * imported — `spawnWorker` resolves the `Worker` identifier at CALL
 * time, so it never needs to be the real thing. This also means the
 * real `diff-worker.ts` / `buildDiffContext` / config never run, so no
 * `WT_CONFIG` plumbing is needed for these tests at all.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const POOL_HREF = JSON.stringify(pathToFileURL(join(import.meta.dir, "pool.ts")).href);

/** Defines `globalThis.Worker` as a controllable fake, then imports the
 *  real `pool.ts` as `pool`. Runs inside a fresh subprocess per scenario. */
const PRELUDE = `
class FakeWorker {
  static instances = [];
  posted = [];
  terminated = false;
  listeners = { message: [], error: [], close: [] };
  constructor(url) { FakeWorker.instances.push(this); }
  postMessage(msg) { this.posted.push(msg); }
  addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
  removeEventListener(type, handler) {
    const list = this.listeners[type];
    if (!list) return;
    const i = list.indexOf(handler);
    if (i !== -1) list.splice(i, 1);
  }
  terminate() { this.terminated = true; }
  unref() {}
  emit(type, event = {}) {
    for (const handler of [...(this.listeners[type] ?? [])]) handler(event);
  }
}
globalThis.Worker = FakeWorker;
const pool = await import(${POOL_HREF});
const runIdOf = (worker) => worker.posted.find((m) => m.type === "run").id;
async function tick() { await new Promise((r) => setTimeout(r, 0)); }
`;

/** Runs `body` (top-level await OK) in a fresh subprocess after the
 *  fake-Worker prelude, and returns the last line it printed, parsed as
 *  JSON. `body` reports its findings via a single trailing `console.log`. */
function runScenario(body: string): unknown {
  const script = `${PRELUDE}\n${body}\n`;
  const r = Bun.spawnSync([process.execPath, "-e", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new TextDecoder().decode(r.stderr);
  const stdout = new TextDecoder().decode(r.stdout).trim();
  if (r.exitCode !== 0) {
    throw new Error(`scenario subprocess exited ${r.exitCode}\n${stderr}\n${stdout}`);
  }
  const lastLine = stdout.split("\n").filter(Boolean).at(-1);
  if (!lastLine) throw new Error(`scenario produced no output\n${stderr}`);
  return JSON.parse(lastLine);
}

test("a cancelled dispatch rejects as AbortError and drops its pending entry", () => {
  const result = runScenario(`
    const ac = new AbortController();
    const pending = pool.buildDiffContextViaPoolPromise("/wt/a", "origin/main", ac.signal);
    // No await yet — the fake worker cannot have replied before this
    // synchronous abort runs, so the cancel path is deterministic.
    ac.abort();
    const worker = FakeWorker.instances[0];
    const id = runIdOf(worker);

    let rejectedName = null;
    try { await pending; } catch (err) { rejectedName = err?.name ?? null; }

    // A late reply for the now-cancelled job must be silently dropped —
    // no pending entry left to resolve/reject a second time.
    let threwOnLateReply = false;
    try {
      worker.emit("message", { data: { type: "result", id, ctx: null } });
    } catch { threwOnLateReply = true; }

    console.log(JSON.stringify({
      rejectedName,
      cancelPosted: worker.posted.some((m) => m.type === "cancel" && m.id === id),
      threwOnLateReply,
    }));
  `);

  expect(result).toEqual({
    rejectedName: "AbortError",
    cancelPosted: true,
    threwOnLateReply: false,
  });
});

test("a worker death rejects only the jobs dispatched to it", () => {
  const result = runScenario(`
    const first = pool.buildDiffContextViaPoolPromise("/wt/a", "origin/main");
    const second = pool.buildDiffContextViaPoolPromise("/wt/b", "origin/main");
    const [workerA, workerB] = FakeWorker.instances;
    const idA = runIdOf(workerA);
    const idB = runIdOf(workerB);

    workerA.emit("error", { message: "boom" });
    let firstError = null;
    try { await first; } catch (err) { firstError = err?.message ?? String(err); }

    // The sibling job on the untouched worker resolves normally.
    workerB.emit("message", { data: { type: "result", id: idB, ctx: { hash: "h2" } } });
    const secondResult = await second;

    console.log(JSON.stringify({
      distinctWorkers: workerA !== workerB,
      firstError,
      workerATerminated: workerA.terminated,
      workerBTerminated: workerB.terminated,
      secondResult,
    }));
  `);

  expect(result).toMatchObject({
    distinctWorkers: true,
    workerATerminated: true,
    workerBTerminated: false,
    secondResult: { hash: "h2" },
  });
  expect((result as { firstError: string }).firstError).toMatch(/diff worker died \(boom\)/);
});

test("disposeDiffPool rejects every pending job as an abort", () => {
  const result = runScenario(`
    const first = pool.buildDiffContextViaPoolPromise("/wt/a", "origin/main");
    const second = pool.buildDiffContextViaPoolPromise("/wt/b", "origin/main");
    const dispatched = [...FakeWorker.instances];

    pool.disposeDiffPoolPromise();

    let firstName = null, secondName = null;
    try { await first; } catch (err) { firstName = err?.name ?? null; }
    try { await second; } catch (err) { secondName = err?.name ?? null; }

    // Disposal is permanent — a dispatch afterward refuses immediately
    // rather than silently re-spawning a pool nothing will tear down.
    let thirdName = null;
    try { await pool.buildDiffContextViaPoolPromise("/wt/c", "origin/main"); }
    catch (err) { thirdName = err?.name ?? null; }

    console.log(JSON.stringify({
      firstName,
      secondName,
      thirdName,
      allTerminated: dispatched.every((w) => w.terminated),
      noNewWorkerAfterDispose: FakeWorker.instances.length === dispatched.length,
    }));
  `);

  expect(result).toEqual({
    firstName: "AbortError",
    secondName: "AbortError",
    thirdName: "AbortError",
    allTerminated: true,
    noNewWorkerAfterDispose: true,
  });
});
