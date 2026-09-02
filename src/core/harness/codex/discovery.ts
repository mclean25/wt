/**
 * Main-thread client for Codex session discovery.
 *
 * A single lazy worker serializes scans. Cursor movement can supersede a query
 * faster than a filesystem scan finishes, so requests wait in a main-thread
 * queue and consume TanStack's AbortSignal. Cancelled queued requests are
 * removed immediately; an already-running synchronous worker scan is allowed
 * to finish, then the newest surviving request runs. This prevents rapid j/k
 * input from building a long tail of obsolete scans while keeping every byte
 * of rollout parsing off the render thread.
 */
import type { HarnessSession } from "../types.ts";
import { Data, Effect } from "effect";
import type {
  CodexDiscoveryRequest,
  CodexDiscoveryResult,
} from "./discovery-protocol.ts";

type Job = {
  id: number;
  slug: string;
  wtPath: string;
  resolve: (sessions: HarnessSession[]) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
  cancelled: boolean;
};

export class CodexDiscoveryError extends Data.TaggedError("CodexDiscoveryError")<{
  readonly cause: unknown;
}> {}

/**
 * Narrow Worker surface used by the queue. Keeping this structural makes the
 * scheduling/cancellation contract testable without starting a real thread;
 * the production factory below still returns Bun's native Worker.
 */
export type CodexDiscoveryWorker = {
  postMessage(message: CodexDiscoveryRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(type: "close", listener: (event: Event) => void): void;
  terminate(): unknown;
  unref?(): void;
};

export type CodexDiscoveryWorkerFactory = () => CodexDiscoveryWorker;

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function post(target: CodexDiscoveryWorker, message: CodexDiscoveryRequest): void {
  target.postMessage(message);
}

/**
 * One serialized Codex discovery lane. A worker scan is synchronous inside
 * its own thread and therefore cannot be interrupted mid-walk; keeping the
 * queue here lets AbortSignal remove superseded destinations before they ever
 * reach that worker.
 */
export class CodexDiscoveryClient {
  private worker: CodexDiscoveryWorker | null = null;
  private active: Job | null = null;
  private queued: Job[] = [];
  private nextId = 1;
  private disposed = false;

  constructor(private readonly workerFactory: CodexDiscoveryWorkerFactory) {}

  discover(
    slug: string,
    wtPath: string,
    signal?: AbortSignal,
  ): Promise<HarnessSession[]> {
    if (this.disposed) {
      return Promise.reject(abortError("codex discovery disposed"));
    }
    return new Promise<HarnessSession[]>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        slug,
        wtPath,
        resolve,
        reject,
        cleanup: () => {},
        cancelled: false,
      };
      if (signal) {
        const onAbort = () => {
          if (job.cancelled) return;
          job.cancelled = true;
          job.cleanup();
          reject(abortError("codex discovery aborted"));
          if (this.active !== job) {
            this.queued = this.queued.filter((candidate) => candidate !== job);
          }
        };
        signal.addEventListener("abort", onAbort, { once: true });
        job.cleanup = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
      }
      if (!job.cancelled) {
        this.queued.push(job);
        this.dispatchNext();
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const err = abortError("codex discovery disposed");
    if (this.active) this.rejectJob(this.active, err);
    this.active = null;
    for (const job of this.queued) this.rejectJob(job, err);
    this.queued = [];
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // already gone
      }
    }
    this.worker = null;
  }

  private rejectJob(job: Job, err: Error): void {
    job.cleanup();
    if (!job.cancelled) job.reject(err);
  }

  private failWorker(reason: string): void {
    const failed = this.worker;
    this.worker = null;
    if (failed) {
      try {
        failed.terminate();
      } catch {
        // already gone
      }
    }
    const err = new Error(`codex discovery worker died (${reason})`);
    if (this.active) this.rejectJob(this.active, err);
    this.active = null;
    for (const job of this.queued) this.rejectJob(job, err);
    this.queued = [];
  }

  private handleMessage = (event: MessageEvent): void => {
    const message = event.data as CodexDiscoveryResult;
    const job = this.active;
    if (!job || message.id !== job.id) return;
    this.active = null;
    job.cleanup();
    if (!job.cancelled) {
      if (message.type === "result") job.resolve(message.sessions);
      else job.reject(new Error(message.message));
    }
    this.dispatchNext();
  };

  private ensureWorker(): CodexDiscoveryWorker {
    if (this.worker) return this.worker;
    const next = this.workerFactory();
    next.addEventListener("message", this.handleMessage);
    next.addEventListener("error", (event) => {
      if (!this.disposed) this.failWorker(event.message || "error");
    });
    next.addEventListener("close", () => {
      if (!this.disposed) this.failWorker("exited");
    });
    next.unref?.();
    this.worker = next;
    return next;
  }

  private dispatchNext(): void {
    if (this.disposed || this.active) return;
    while (this.queued.length > 0) {
      const job = this.queued.shift()!;
      if (job.cancelled) continue;
      this.active = job;
      try {
        post(this.ensureWorker(), {
          type: "discover",
          id: job.id,
          slug: job.slug,
          wtPath: job.wtPath,
        });
      } catch (err) {
        this.active = null;
        this.rejectJob(job, err instanceof Error ? err : new Error(String(err)));
        this.failWorker("dispatch failed");
      }
      return;
    }
  }
}

const discoveryClient = new CodexDiscoveryClient(
  () => new Worker(new URL("./discovery-worker.ts", import.meta.url).href),
);

export function discoverCodexSessionsInWorker(
  slug: string,
  wtPath: string,
  signal?: AbortSignal,
): Promise<HarnessSession[]> {
  return discoveryClient.discover(slug, wtPath, signal);
}

export function discoverCodexSessionsEffect(slug: string, wtPath: string) {
  return Effect.tryPromise({
    try: (signal) => discoveryClient.discover(slug, wtPath, signal),
    catch: (cause) => new CodexDiscoveryError({ cause }),
  });
}

export function disposeCodexDiscoveryWorker(): void {
  discoveryClient.dispose();
}
