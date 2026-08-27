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
  /** Complete endpoint captured with the row; never resolve via a singleton. */
  remote: RemoteConfig;
  /** Stable SSH destination used for local fleet-ledger identity. */
  hostKey: string;
  hostLabel: string;
  slug: string;
  branch: string;
  /** Effective merge target reported by the remote wt. */
  base: string | null;
  path: string;
  stage: string;
  /** Strict remote equivalent of the local `deployed` action requirement. */
  deployed: boolean;
  /** Manual section owned by the remote wt state; null means Inbox. */
  section: string | null;
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
  issueId: string | null;
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
  /**
   * External merge gate (`wt status --blocked-on`). Non-null means the
   * remote's `ready` is NOT mergeable. Null on a remote running a wt
   * that predates the field, which reads the same as "no gate" — the
   * only tolerant option, and the reason the local surfaces all gained
   * it in one change rather than one at a time.
   */
  workBlockedOn: string | null;
  /**
   * A deployed-environment check the branch owes once it lands
   * (`wt status --verify-after-merge`). Reads the opposite way from
   * the gate: the row SHOULD merge, and once it has, a non-null value
   * means the check has not happened and the remote checkout is being
   * kept alive for it. Null on an older remote wt, same tolerance.
   */
  workVerifyAfterMerge: string | null;
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
  hostKey: string = hostLabel,
  remote: RemoteConfig = {
    host: hostKey,
    label: hostLabel,
    wtPath: "~/.wt/bin/wt",
  },
): RemoteWorktreeSummary[] {
  const value: unknown = parseWorktreeJson(raw);
  if (!Array.isArray(value)) throw new Error("remote wt ls returned non-array JSON");
  // `wt ls --json` appends recently-removed rows, discriminated by
  // `kind` — see core/wtstate/removed.ts. The fleet renders live
  // worktrees only, so drop removed-history entries here.
  //
  // Keep on the VALUE, never on the key's absence: hosts run
  // independently-updated wt versions, and `kind` has meant three things
  // across them — absent (before it existed), then `merged`/`removed` on
  // archived rows only, and now `live` on live rows too. A host that
  // tested for the key's presence would drop every row from a newer
  // remote and render the section empty, which looks exactly like a host
  // with no worktrees. Unknown future kinds skip that row rather than
  // poisoning the host's whole list, same as an unparseable one.
  // (`state` was the discriminator for one release; still dropped.)
  const live = value.filter((entry) => {
    if (!entry || typeof entry !== "object") return false;
    if ("state" in entry) return false;
    if (!("kind" in entry)) return true;
    return (entry as { kind?: unknown }).kind === "live";
  });
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
      remote,
      hostKey,
      hostLabel,
      slug: str("slug"),
      branch: str("branch"),
      base: typeof row.base === "string" ? row.base : null,
      path: str("path"),
      stage: str("stage"),
      deployed: row.deployed === true,
      section: typeof row.section === "string" ? row.section : null,
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
      issueId: typeof row.issue_id === "string" ? row.issue_id : null,
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
      workBlockedOn:
        typeof row.work_blocked_on === "string" && row.work_blocked_on.trim() !== ""
          ? sanitizeWorkNote(row.work_blocked_on)
          : null,
      workVerifyAfterMerge:
        typeof row.work_verify_after_merge === "string" &&
        row.work_verify_after_merge.trim() !== ""
          ? sanitizeWorkNote(row.work_verify_after_merge)
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
  return parseRemoteWorktrees(result.stdout, remote.label, remote.host, remote);
}
