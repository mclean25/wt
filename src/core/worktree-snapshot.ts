import { existsSync } from "node:fs";
import { Data, Effect } from "effect";

import { config } from "./config.ts";
import { devServerStatus, type DevServerStatus } from "./dev-server.ts";
import { githubIssueUrl, issueUrlForId, resolveIssueId } from "./issue-tracker.ts";
import { isOurStageDeployed } from "./stage-safety.ts";
import { StatusKind, type Status, type Worktree } from "./types.ts";
import { parseWorkStatus, type WorkStatusRecord } from "./work-status.ts";
import { readWtState } from "./wtstate.ts";
import { listWorktreesEffect, pushCountsEffect, worktreeStatusEffect } from "./worktree.ts";
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
export function collectWorktreeSnapshotsEffect(
  discovered?: readonly Worktree[],
): Effect.Effect<WorktreeSnapshot[], WorktreeSnapshotError> {
  return Effect.gen(function* () {
  const states = readWtState().slugs;
  const rows = (discovered ?? (yield* listWorktreesEffect().pipe(
    Effect.mapError((cause) => new WorktreeSnapshotError({ operation: "discover", cause })),
  ))).filter((worktree) => !worktree.isMain);
  return yield* Effect.all(
    rows.map((worktree) => Effect.gen(function* () {
      const [status, push, dev] = yield* Effect.all([
        worktreeStatusEffect(worktree),
        pushCountsEffect(worktree.path),
        Effect.tryPromise({
          try: () => devServerStatus(worktree.slug, { path: worktree.path }),
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
}

export const collectWorktreeSnapshots = (
  discovered?: readonly Worktree[],
): Promise<WorktreeSnapshot[]> => Effect.runPromise(collectWorktreeSnapshotsEffect(discovered));

export function collectWorkerSnapshotEffect(): Effect.Effect<WorkerSnapshot, WorktreeSnapshotError> {
  return collectWorktreeSnapshotsEffect().pipe(Effect.map((worktrees) => ({
    protocol: WORKER_PROTOCOL_VERSION,
    worktrees,
  })));
}

export const collectWorkerSnapshot = (): Promise<WorkerSnapshot> =>
  Effect.runPromise(collectWorkerSnapshotEffect());

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

function parseDev(raw: unknown, index: number): DevServerStatus {
  if (!raw || typeof raw !== "object") {
    throw new Error(`remote worker snapshot ${index}.dev is invalid`);
  }
  const value = raw as Partial<DevServerStatus>;
  const bool = (key: "running" | "starting" | "crashed"): boolean => {
    if (typeof value[key] !== "boolean") {
      throw new Error(`remote worker snapshot ${index}.dev.${key} is invalid`);
    }
    return value[key];
  };
  const nullableNumber = (key: "port" | "since"): number | null => {
    const field = value[key];
    if (field === null) return null;
    if (typeof field !== "number" || !Number.isFinite(field)) {
      throw new Error(`remote worker snapshot ${index}.dev.${key} is invalid`);
    }
    return field;
  };
  const running = bool("running");
  const starting = bool("starting");
  const crashed = bool("crashed");
  if (value.url !== null && typeof value.url !== "string") {
    throw new Error(`remote worker snapshot ${index}.dev.url is invalid`);
  }
  if (value.waiting !== null &&
      (!value.waiting || !Number.isInteger(value.waiting.rank) ||
        !Number.isFinite(value.waiting.since))) {
    throw new Error(`remote worker snapshot ${index}.dev.waiting is invalid`);
  }
  if (value.rebasedSince !== null && typeof value.rebasedSince !== "boolean") {
    throw new Error(`remote worker snapshot ${index}.dev.rebasedSince is invalid`);
  }
  if (value.restarts !== null &&
      (!value.restarts || !Number.isInteger(value.restarts.count) ||
        !Number.isInteger(value.restarts.lastExit))) {
    throw new Error(`remote worker snapshot ${index}.dev.restarts is invalid`);
  }
  return {
    running,
    starting,
    crashed,
    port: nullableNumber("port"),
    url: value.url,
    since: nullableNumber("since"),
    waiting: value.waiting,
    rebasedSince: value.rebasedSince,
    restarts: value.restarts,
  };
}

const STATUS_KINDS = new Set<string>(Object.values(StatusKind));

/** Strict parser: the handshake version is what makes this contract safe. */
export function parseWorkerSnapshot(raw: string): WorkerSnapshot {
  const parsed = parseJsonPayload(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("remote worker snapshot returned an invalid payload");
  }
  const envelope = parsed as { protocol?: unknown; worktrees?: unknown };
  if (envelope.protocol !== WORKER_PROTOCOL_VERSION) {
    throw new Error(
      `remote worker snapshot uses protocol ${String(envelope.protocol)}; expected ${WORKER_PROTOCOL_VERSION}`,
    );
  }
  if (!Array.isArray(envelope.worktrees)) {
    throw new Error("remote worker snapshot worktrees is not an array");
  }
  const worktrees = envelope.worktrees.map((rawRow, index): WorktreeSnapshot => {
    if (!rawRow || typeof rawRow !== "object") {
      throw new Error(`remote worker snapshot ${index} is not an object`);
    }
    const row = rawRow as Record<string, unknown>;
    const str = (key: string): string => {
      if (typeof row[key] !== "string") {
        throw new Error(`remote worker snapshot ${index}.${key} is invalid`);
      }
      return row[key];
    };
    const bool = (key: string): boolean => {
      if (typeof row[key] !== "boolean") {
        throw new Error(`remote worker snapshot ${index}.${key} is invalid`);
      }
      return row[key];
    };
    const nullableNumber = (key: string): number | null => {
      const field = row[key];
      if (field === null) return null;
      if (typeof field !== "number" || !Number.isFinite(field)) {
        throw new Error(`remote worker snapshot ${index}.${key} is invalid`);
      }
      return field;
    };
    const nullableString = (key: string): string | null => {
      const field = row[key];
      if (field === null) return null;
      if (typeof field !== "string") {
        throw new Error(`remote worker snapshot ${index}.${key} is invalid`);
      }
      return field;
    };
    const nullableBoolean = (key: string): boolean | null => {
      const field = row[key];
      if (field === null) return null;
      if (typeof field !== "boolean") {
        throw new Error(`remote worker snapshot ${index}.${key} is invalid`);
      }
      return field;
    };
    const rawStatus = row.status;
    if (!rawStatus || typeof rawStatus !== "object") {
      throw new Error(`remote worker snapshot ${index}.status is invalid`);
    }
    const statusRow = rawStatus as Record<string, unknown>;
    const kind = statusRow.kind;
    if (typeof kind !== "string" || !STATUS_KINDS.has(kind)) {
      throw new Error(`remote worker snapshot ${index}.status.kind is invalid`);
    }
    if (typeof statusRow.label !== "string") {
      throw new Error(`remote worker snapshot ${index}.status.label is invalid`);
    }
    const status: Status = {
      kind: kind as Status["kind"],
      label: statusRow.label,
      ...(typeof statusRow.age === "string" ? { age: statusRow.age } : {}),
      ...(typeof statusRow.op === "string" ? { op: statusRow.op } : {}),
      ...(typeof statusRow.log === "string" ? { log: statusRow.log } : {}),
      ...(typeof statusRow.pid === "number" ? { pid: statusRow.pid } : {}),
    };
    const work = parseWorkStatus(row.work);
    if (row.work !== null && work === null) {
      throw new Error(`remote worker snapshot ${index}.work is invalid`);
    }
    return {
      slug: str("slug"),
      branch: str("branch"),
      base: str("base"),
      path: str("path"),
      stage: str("stage"),
      deployed: bool("deployed"),
      exists: bool("exists"),
      status,
      dev: parseDev(row.dev, index),
      dirty: bool("dirty"),
      unpushed: nullableNumber("unpushed"),
      pushed: nullableBoolean("pushed"),
      aheadOfBase: nullableNumber("aheadOfBase"),
      issueId: nullableString("issueId"),
      issueUrl: nullableString("issueUrl"),
      githubIssue: nullableNumber("githubIssue"),
      githubIssueUrl: nullableString("githubIssueUrl"),
      work,
    };
  });
  return { protocol: WORKER_PROTOCOL_VERSION, worktrees };
}
