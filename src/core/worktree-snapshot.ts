import { existsSync } from "node:fs";
import { Data, Effect, Schema } from "effect";

import { config } from "./config.ts";
import { devServerStatusPromise, type DevServerStatus } from "./dev-server.ts";
import { githubIssueUrl, issueUrlForId, resolveIssueId } from "./issue-tracker.ts";
import { isOurStageDeployed } from "./stage-safety.ts";
import { StatusKind, type Status, type Worktree } from "./types.ts";
import { parseWorkStatus, type WorkStatusRecord } from "./work-status.ts";
import { readWtState } from "./wtstate.ts";
import { listWorktrees, pushCounts, worktreeStatus } from "./worktree.ts";
import { WORKER_PROTOCOL_VERSION } from "./worker-info.ts";
import { causeMessage } from "./errors.ts";

/**
 * Location-neutral execution state for one checkout.
 *
 * This is the worker/controller boundary. It deliberately excludes layout,
 * archive state, PR data, and SSH coordinates: those belong to the controller.
 * Local and remote inventory adapters both feed this shape into the TUI's
 * WorktreeModel; only the execution target differs.
 */
export type WorktreeSnapshot = {
  slug: string;
  branch: string;
  base: string;
  path: string;
  stage: string;
  deployed: boolean;
  exists: boolean;
  status: Status;
  dev: DevServerStatus;
  dirty: boolean;
  unpushed: number | null;
  pushed: boolean | null;
  aheadOfBase: number | null;
  issueId: string | null;
  issueUrl: string | null;
  githubIssue: number | null;
  githubIssueUrl: string | null;
  work: WorkStatusRecord | null;
};

export type WorkerSnapshot = {
  protocol: number;
  worktrees: WorktreeSnapshot[];
};

export class WorktreeSnapshotError extends Data.TaggedError("WorktreeSnapshotError")<{
  readonly slug?: string;
  readonly operation: "discover" | "status" | "dev";
  readonly cause: unknown;
}> {
  override get message(): string {
    const where = this.slug ? `${this.slug} ${this.operation}` : this.operation;
    return `${where}: ${causeMessage(this.cause)}`;
  }
}

/** Collect the authoritative execution state once for CLI and SSH consumers. */
export const collectWorktreeSnapshots = Effect.fn("collectWorktreeSnapshots")(function* (
  discovered?: readonly Worktree[],
): Effect.fn.Return<WorktreeSnapshot[], WorktreeSnapshotError> {
  const states = readWtState().slugs;
  const rows = (discovered ?? (yield* listWorktrees().pipe(
    Effect.mapError((cause) => new WorktreeSnapshotError({ operation: "discover", cause })),
  ))).filter((worktree) => !worktree.isMain);
  return yield* Effect.all(
    rows.map((worktree) => Effect.gen(function* () {
      const [status, push, dev] = yield* Effect.all([
        worktreeStatus(worktree),
        pushCounts(worktree.path),
        Effect.tryPromise({
          try: () => devServerStatusPromise(worktree.slug, { path: worktree.path }),
          catch: (cause) => new WorktreeSnapshotError({ slug: worktree.slug, operation: "dev", cause }),
        }),
      ], { concurrency: "unbounded" }).pipe(
        Effect.mapError((cause) => cause instanceof WorktreeSnapshotError
          ? cause
          : new WorktreeSnapshotError({ slug: worktree.slug, operation: "status", cause })),
      );
      const state = states[worktree.slug];
      const issueId = resolveIssueId(worktree.slug, state?.issueId);
      const githubIssue = state?.githubIssue ?? null;
      return {
        slug: worktree.slug,
        branch: worktree.branch,
        base: state?.baseBranch ?? config.branch.base,
        path: worktree.path,
        stage: worktree.stage,
        deployed: isOurStageDeployed(worktree),
        exists: existsSync(worktree.path),
        status,
        dev,
        dirty: status.kind === StatusKind.Dirty,
        unpushed: push.unpushed,
        pushed: push.pushed,
        aheadOfBase: push.aheadOfBase,
        issueId,
        issueUrl: issueUrlForId(issueId),
        githubIssue,
        githubIssueUrl: githubIssue ? githubIssueUrl(githubIssue) : null,
        work: state?.work ?? null,
      };
    })),
    { concurrency: "unbounded" },
  );
});

export const collectWorktreeSnapshotsPromise = (
  discovered?: readonly Worktree[],
): Promise<WorktreeSnapshot[]> => Effect.runPromise(collectWorktreeSnapshots(discovered));

export function collectWorkerSnapshot(): Effect.Effect<WorkerSnapshot, WorktreeSnapshotError> {
  return collectWorktreeSnapshots().pipe(Effect.map((worktrees) => ({
    protocol: WORKER_PROTOCOL_VERSION,
    worktrees,
  })));
}

export const collectWorkerSnapshotPromise = (): Promise<WorkerSnapshot> =>
  Effect.runPromise(collectWorkerSnapshot());

function parseJsonPayload(raw: string): unknown {
  try {
    return JSON.parse(raw.trim());
  } catch {
    // Login-shell startup output can surround the payload. `_snapshot` emits
    // one object and nothing after it, so the outer object is unambiguous.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        // Fall through to the useful protocol diagnostic below.
      }
    }
    throw new Error(
      `remote worker snapshot did not return JSON. Got: ${raw.trim().slice(0, 200) || "(empty)"}`,
    );
  }
}

// The one Schema use in the codebase: untrusted JSON off an SSH worker's
// stdout, replacing ~150 lines of hand-rolled `str`/`bool`/`nullableNumber`
// helpers with field-pathed decode errors. `work` is deliberately left as
// `Schema.Unknown` and validated afterward via `parseWorkStatus` — the
// canonical work-status decoder shared with every other reader of that
// shape — rather than re-implementing its rules here.
const DevServerStatusSchema = Schema.Struct({
  running: Schema.Boolean,
  starting: Schema.Boolean,
  crashed: Schema.Boolean,
  port: Schema.NullOr(Schema.Finite),
  url: Schema.NullOr(Schema.String),
  since: Schema.NullOr(Schema.Finite),
  waiting: Schema.NullOr(Schema.Struct({ rank: Schema.Int, since: Schema.Finite })),
  rebasedSince: Schema.NullOr(Schema.Boolean),
  restarts: Schema.NullOr(Schema.Struct({ count: Schema.Int, lastExit: Schema.Int })),
}) satisfies Schema.Schema<DevServerStatus>;

const STATUS_KINDS = Object.values(StatusKind) as [StatusKind, ...StatusKind[]];
const StatusSchema = Schema.Struct({
  kind: Schema.Literals(STATUS_KINDS),
  label: Schema.String,
  age: Schema.optional(Schema.String),
  log: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
  op: Schema.optional(Schema.String),
}) satisfies Schema.Schema<Status>;

const WorktreeSnapshotRowSchema = Schema.Struct({
  slug: Schema.String,
  branch: Schema.String,
  base: Schema.String,
  path: Schema.String,
  stage: Schema.String,
  deployed: Schema.Boolean,
  exists: Schema.Boolean,
  status: StatusSchema,
  dev: DevServerStatusSchema,
  dirty: Schema.Boolean,
  unpushed: Schema.NullOr(Schema.Finite),
  pushed: Schema.NullOr(Schema.Boolean),
  aheadOfBase: Schema.NullOr(Schema.Finite),
  issueId: Schema.NullOr(Schema.String),
  issueUrl: Schema.NullOr(Schema.String),
  githubIssue: Schema.NullOr(Schema.Finite),
  githubIssueUrl: Schema.NullOr(Schema.String),
  work: Schema.Unknown,
});

const WorkerEnvelopeSchema = Schema.Struct({
  protocol: Schema.Literal(WORKER_PROTOCOL_VERSION),
  worktrees: Schema.mutable(Schema.Array(WorktreeSnapshotRowSchema)),
});

const decodeWorkerEnvelope = Schema.decodeUnknownSync(WorkerEnvelopeSchema);

/**
 * `Schema.decodeUnknownSync` throws with a bracket-notation path (`at
 * ["worktrees"][0]["status"]["kind"]`) ahead of the reason. Reduce that
 * to the old hand-rolled validator's `<row-index>.<dotted-field> is
 * invalid` wording — callers keyed their own diagnostics (and tests) to
 * the exact phrase naming which field broke, and it reads better than
 * the bracket form besides.
 */
function schemaDecodeError(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const pathMatch = /at ((?:\["[^"]*"\]|\[\d+\])+)/.exec(message);
  const segments = pathMatch?.[1]
    ? [...pathMatch[1].matchAll(/\["([^"]*)"\]|\[(\d+)\]/g)].map((m) => m[1] ?? m[2]!)
    : [];
  if (segments[0] === "worktrees" && segments.length >= 2) {
    const [, rowIndex, ...field] = segments;
    const where = field.length > 0 ? `${rowIndex}.${field.join(".")}` : rowIndex;
    return new Error(`remote worker snapshot ${where} is invalid`);
  }
  if (segments[0] === "worktrees") {
    return new Error("remote worker snapshot worktrees is not an array");
  }
  return new Error(`remote worker snapshot payload is invalid (${message.split("\n")[0]})`);
}

/** Strict parser: the handshake version is what makes this contract safe. */
export function parseWorkerSnapshot(raw: string): WorkerSnapshot {
  const parsed = parseJsonPayload(raw);
  // Checked ahead of the full decode so a protocol mismatch (an old/new
  // build talking to each other) gets the friendly, actionable message
  // instead of a field-pathed schema error about the shape underneath it.
  const protocol = parsed && typeof parsed === "object" ? (parsed as { protocol?: unknown }).protocol : undefined;
  if (protocol !== WORKER_PROTOCOL_VERSION) {
    throw new Error(
      `remote worker snapshot uses protocol ${String(protocol)}; expected ${WORKER_PROTOCOL_VERSION}`,
    );
  }
  let envelope: ReturnType<typeof decodeWorkerEnvelope>;
  try {
    envelope = decodeWorkerEnvelope(parsed);
  } catch (err) {
    throw schemaDecodeError(err);
  }
  const worktrees = envelope.worktrees.map((row, index): WorktreeSnapshot => {
    const work = parseWorkStatus(row.work);
    if (row.work !== null && work === null) {
      throw new Error(`remote worker snapshot ${index}.work is invalid`);
    }
    return { ...row, work };
  });
  return { protocol: envelope.protocol, worktrees };
}
