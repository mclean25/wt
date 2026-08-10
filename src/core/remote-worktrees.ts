import type { RemoteConfig } from "./config.ts";
import { run } from "./proc.ts";
import { remoteWtCommand } from "./remote-protocol.ts";
import { StatusKind, type StatusKind as StatusKindValue } from "./types.ts";
import {
  sanitizeWorkNote,
  WORK_RISKS,
  WORK_STATES,
  type WorkRisk,
  type WorkState,
} from "./work-status.ts";

export type RemoteWorktreeSummary = {
  hostLabel: string;
  slug: string;
  branch: string;
  path: string;
  stage: string;
  exists: boolean;
  status: StatusKindValue;
  statusLabel: string;
  statusAge: string | null;
  statusOp: string | null;
  dirty: boolean;
  unpushed: number;
  /**
   * Whether `origin/<branch>` exists on the remote host's repo — rides
   * `wt ls --json`'s `pushed`. Null when the remote wt predates the
   * field (older binaries), so consumers can't mistake "unknown" for
   * "never pushed".
   */
  pushed: boolean | null;
  /**
   * Commits ahead of the branch's upstream/base (`ahead_of_base`) — the
   * restack-pressure signal. Null when the remote wt predates it.
   */
  aheadOfBase: number | null;
  issueUrl: string | null;
  /**
   * Work status asserted on the remote host (`work_*` in its
   * `wt ls --json`). All null when unasserted OR when the remote wt
   * predates the fields — tolerant by design so mixed versions keep
   * listing. The note/risk/at ride along so a future remote details
   * view has them; today only the state (the dot) renders.
   */
  workState: WorkState | null;
  workNote: string | null;
  workRisk: WorkRisk | null;
  workAt: string | null;
};

const STATUS_KINDS = new Set<string>(Object.values(StatusKind));

/**
 * The remote `wt ls --json` runs through the account's login shell, which
 * can prepend/append stray output (fish/bash startup banners, direnv,
 * asdf/nvm, motd tooling) even for a non-interactive command. That noise
 * corrupts a naive `JSON.parse`, and the resulting `SyntaxError` is
 * indistinguishable in the UI from a genuine SSH failure. Only the argv-IN
 * direction is base64-hardened; this hardens the JSON-OUT direction: parse
 * the raw text, and on failure fall back to the outer `[...]` slice (the
 * payload is pretty-printed and is the last real thing wt emits) before
 * giving up with a diagnostic that names the actual cause.
 */
function parseWorktreeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1));
      } catch {
        /* fall through to the diagnostic below */
      }
    }
    const snippet = raw.trim().slice(0, 200);
    throw new Error(
      `remote wt ls did not return JSON — check the remote shell startup for stray output. Got: ${snippet || "(empty)"}`,
    );
  }
}

export function parseRemoteWorktrees(
  raw: string,
  hostLabel: string,
): RemoteWorktreeSummary[] {
  const value: unknown = parseWorktreeJson(raw);
  if (!Array.isArray(value)) throw new Error("remote wt ls returned non-array JSON");
  // `wt ls --json` appends recently-removed rows (discriminated by a
  // `kind` field live rows never carry — see core/wtstate/removed.ts;
  // `state` was the discriminator for one release, kept for skew). The
  // remote section renders live worktrees only, so drop them here;
  // older remotes simply don't emit them. Filtering must be per-entry
  // lenient: hosts run independently-updated wt versions, and one
  // unrecognized future row shape must degrade to a skipped row, not
  // poison the host's whole live list.
  const live = value.filter(
    (entry) =>
      !(entry && typeof entry === "object" && ("kind" in entry || "state" in entry)),
  );
  return live.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`remote worktree ${index} is not an object`);
    }
    const row = entry as Record<string, unknown>;
    const str = (key: string): string => {
      const v = row[key];
      if (typeof v !== "string") throw new Error(`remote worktree ${index}.${key} is not a string`);
      return v;
    };
    const status = str("status");
    if (!STATUS_KINDS.has(status)) {
      throw new Error(`remote worktree ${index}.status is invalid: ${status}`);
    }
    const statusLabel = str("status_label");
    const statusOp = typeof row.status_op === "string"
      ? row.status_op
      : status === StatusKind.Busy &&
          (statusLabel === "init" || statusLabel.startsWith("init:"))
        ? "init"
        : null;
    return {
      hostLabel,
      slug: str("slug"),
      branch: str("branch"),
      path: str("path"),
      stage: str("stage"),
      exists: row.exists === true,
      status: status as StatusKindValue,
      statusLabel,
      statusAge: typeof row.status_age === "string" ? row.status_age : null,
      statusOp,
      dirty: row.dirty === true,
      unpushed:
        typeof row.unpushed === "number" &&
        Number.isInteger(row.unpushed) &&
        row.unpushed >= 0
          ? row.unpushed
          : 0,
      pushed: typeof row.pushed === "boolean" ? row.pushed : null,
      aheadOfBase:
        typeof row.ahead_of_base === "number" &&
        Number.isInteger(row.ahead_of_base) &&
        row.ahead_of_base >= 0
          ? row.ahead_of_base
          : null,
      issueUrl: typeof row.issue_url === "string" ? row.issue_url : null,
      workState:
        typeof row.work_state === "string" &&
        (WORK_STATES as readonly string[]).includes(row.work_state)
          ? (row.work_state as WorkState)
          : null,
      workNote:
        typeof row.work_note === "string" && row.work_note.trim() !== ""
          ? sanitizeWorkNote(row.work_note)
          : null,
      workRisk:
        typeof row.work_risk === "string" &&
        (WORK_RISKS as readonly string[]).includes(row.work_risk)
          ? (row.work_risk as WorkRisk)
          : null,
      workAt: typeof row.work_at === "string" ? row.work_at : null,
    };
  });
}

/** Read the authoritative worktree list from one configured SSH host. */
export async function fetchRemoteWorktrees(
  remote: RemoteConfig,
  signal?: AbortSignal,
): Promise<RemoteWorktreeSummary[]> {
  const result = await run(
    [
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      remote.host,
      remoteWtCommand(remote, ["ls", "--json"]),
    ],
    { cwd: process.cwd(), timeoutMs: 15_000, signal },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `SSH exited ${result.exitCode}`);
  }
  return parseRemoteWorktrees(result.stdout, remote.label);
}
