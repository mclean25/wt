import { StatusKind } from "../../core/types.ts";
import { destroyHazard, destroyHazardLabel } from "../app-helpers.ts";
import { NF } from "../icons.ts";
import { Modal } from "../modal.tsx";
import { ScrollableList } from "./scroll-list.tsx";
import { theme } from "../theme.ts";
import {
  remoteCleanHazardLabel,
  type CleanCandidate,
} from "../clean-candidate.ts";
import { remoteWorktreeLedgerKey } from "../../core/worktree-ref.ts";

type Props = {
  candidates: readonly CleanCandidate[];
};

/**
 * Human-readable "why is this safe to clean" for a row. Always one of:
 * merged (git-level), gone (branch deleted upstream), PR merged (GitHub
 * says so even if local git hasn't caught up yet).
 */
function reasonFor(candidate: CleanCandidate): string {
  const status =
    candidate.kind === "local" ? candidate.row.status.kind : candidate.entry.status;
  if (status === StatusKind.Merged) return "merged";
  if (status === StatusKind.Gone) return "gone";
  if (
    (candidate.kind === "local" && candidate.row.pr?.state === "MERGED") ||
    (candidate.kind === "remote" && candidate.pr?.state === "MERGED")
  ) {
    return "PR merged";
  }
  return "—";
}

function hazardFor(candidate: CleanCandidate): string | null {
  if (candidate.kind === "remote") {
    return remoteCleanHazardLabel(candidate.entry);
  }
  const hazard = destroyHazard(candidate.row);
  return hazard ? destroyHazardLabel(hazard) : null;
}

export function CleanConfirmModal({ candidates }: Props) {
  // The sweep refuses to force, so a candidate holding uncommitted work
  // or unpushed commits survives it (see `doCleanRows`). Count and label
  // what will ACTUALLY be destroyed — a modal that promises 5 and
  // delivers 4 is how a kept row gets read as a lost one.
  const doomed = candidates.filter((candidate) => hazardFor(candidate) === null);
  const count = doomed.length;
  const keptCount = candidates.length - count;
  const stageCount = doomed.filter(
    (candidate) =>
      candidate.kind === "local" && candidate.row.fields.deploy.data,
  ).length;

  return (
    <Modal
      title={`clean · ${count} worktree${count === 1 ? "" : "s"}${keptCount > 0 ? ` · ${keptCount} kept` : ""}`}
      borderColor={theme.warn}
      inset={{ top: "15%", right: "15%", bottom: "15%", left: "15%" }}
      hints={[
        ["y", "confirm"],
        ["n / esc / q", "cancel"],
      ]}
    >
      <box flexDirection="column" marginBottom={1}>
        <text fg={theme.fg}>
          About to destroy{" "}
          <span fg={theme.warn} attributes={1}>
            {count}
          </span>{" "}
          worktree{count === 1 ? "" : "s"}
          {stageCount > 0 ? (
            <>
              {" · "}
              <span fg={theme.warn}>{stageCount}</span> stage
              {stageCount === 1 ? "" : "s"}
            </>
          ) : null}
          . Branches will be deleted.
          {keptCount > 0 ? (
            <>
              {" "}
              <span fg={theme.warn}>{keptCount}</span> kept — destroy those
              with d to force.
            </>
          ) : null}
        </text>
      </box>
      <ScrollableList>
        {candidates.map((candidate) => {
          const row = candidate.kind === "local" ? candidate.row : null;
          const remote = candidate.kind === "remote" ? candidate.entry : null;
          const deployed = row?.fields.deploy.data ?? false;
          const hazard = hazardFor(candidate);
          const key = row
            ? `local:${row.wt.slug}`
            : `remote:${remoteWorktreeLedgerKey(remote!.hostKey, remote!.slug)}`;
          const label = row ? row.wt.slug : `${remote!.slug} @ ${remote!.hostLabel}`;
          return (
            <box key={key} flexDirection="row">
              <box width={2} flexShrink={0}>
                <text fg={theme.fgDim}>·</text>
              </box>
              <box flexGrow={1} flexShrink={1} overflow="hidden">
                <text fg={hazard ? theme.fgDim : theme.fg} wrapMode="none" truncate>
                  {label}
                </text>
              </box>
              <box flexShrink={0} flexDirection="row">
                <text fg={theme.fgDim}>{"  "}</text>
                <text fg={theme.fgDim}>{reasonFor(candidate).padEnd(10)}</text>
                {hazard ? (
                  <text fg={theme.warn}> kept · {hazard}</text>
                ) : remote ? (
                  <text fg={theme.fgDim}> remote</text>
                ) : deployed ? (
                  // Two spaces after the bolt: opentui's native renderer
                  // treats the PUA codepoint as 1-cell wide so a single
                  // space leaves "destroys" overlapping the icon's right
                  // half. Same pattern as `ChecksBadge` in details.
                  <text fg={theme.warn}> {NF.bolt}  destroys stage</text>
                ) : (
                  <text fg={theme.fgDim}> no stage</text>
                )}
              </box>
            </box>
          );
        })}
      </ScrollableList>
    </Modal>
  );
}
