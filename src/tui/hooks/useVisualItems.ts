import { useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import { config } from "../../core/config.ts";
import type { ReviewRequestPr } from "../../core/github.ts";
import { reviewRequestsQuery } from "../../state/index.ts";
import type { FleetWorktreeItem, ListActiveItem } from "../panels/list.tsx";
import type { RemoteCreation } from "../remote-creation.ts";
import type { RemoteWorktreeSummary } from "../../core/remote-worktrees.ts";
import type { GithubData } from "../../state/queries/github.ts";
import { remoteWorktreeLedgerKey } from "../../core/worktree-ref.ts";
import {
  localWorktreeTarget,
  remoteWorktreeTarget,
  type WorktreeTarget,
} from "../../core/worktree-target.ts";
import { remoteEntryKey } from "../remote-creation.ts";
import {
  buildWorktreeModels,
  type WorktreeModel,
} from "../worktree-model.ts";
import {
  GROUP_ARCHIVED,
  GROUP_INBOX,
  type WorktreeRow,
} from "./useWorktreeRows.ts";

export type VisualItem = ListActiveItem | { kind: "pr"; pr: ReviewRequestPr };
export type ArchivedItem =
  | {
      kind: "wt";
      row: WorktreeRow;
      target: WorktreeTarget;
      model: WorktreeModel;
    }
  | {
      kind: "remote";
      entry: RemoteWorktreeSummary;
      target: WorktreeTarget;
      model: WorktreeModel;
      archived: true;
    }
  /** The whole block, folded to one header line (`GROUP_ARCHIVED`). */
  | SelectedSection;
export type SelectedSection = Extract<ListActiveItem, { kind: "section" }>;

function entrySection(entry: RemoteCreation | RemoteWorktreeSummary): string {
  return "section" in entry && entry.section !== null ? entry.section : GROUP_INBOX;
}

/** Build the visible active fleet with location-neutral section grouping. */
export function buildActiveItems({
  rows,
  foldedSections,
  remoteCreation,
  remoteWorktrees,
  archivedKeys,
  githubData,
}: Omit<UseVisualItemsArgs, "selectedKey">): ListActiveItem[] {
  const models = buildWorktreeModels(rows, remoteWorktrees, archivedKeys, githubData);
  const byKey = new Map(models.map((model) => [model.key, model]));
  const buckets = new Map<string, FleetWorktreeItem[]>();
  const ensure = (section: string): FleetWorktreeItem[] => {
    const existing = buckets.get(section);
    if (existing) return existing;
    const created: FleetWorktreeItem[] = [];
    buckets.set(section, created);
    return created;
  };

  for (const row of rows) {
    if (row.archived) continue;
    ensure(row.section ?? GROUP_INBOX).push({
      kind: "wt",
      row,
      target: localWorktreeTarget(row.wt),
      model: byKey.get(row.wt.slug)!,
    });
  }
  for (const entry of remoteWorktrees) {
    if (archivedKeys.has(remoteWorktreeLedgerKey(entry.hostKey, entry.slug))) continue;
    ensure(entrySection(entry)).push({
      kind: "remote",
      entry,
      target: remoteWorktreeTarget(entry),
      model: byKey.get(remoteWorktreeLedgerKey(entry.hostKey, entry.slug))!,
      archived: false,
    });
  }
  if (remoteCreation && !remoteWorktrees.some((row) => row.slug === remoteCreation.input)) {
    ensure(GROUP_INBOX).push({
      kind: "remote",
      entry: remoteCreation,
      target: null,
      model: null,
      archived: false,
    });
  }

  const out: ListActiveItem[] = [];
  for (const [sectionKey, members] of buckets) {
    if (foldedSections.has(sectionKey)) {
      out.push({
        kind: "section" as const,
        sectionKey,
        label: sectionKey === GROUP_INBOX ? "Inbox" : sectionKey,
        members,
      });
    } else {
      out.push(...members);
    }
  }
  return out;
}

export function visualKey(item: VisualItem): string {
  return item.kind === "wt"
    ? item.row.wt.slug
    : item.kind === "remote"
      ? `remote:${remoteEntryKey(item.entry)}`
    : item.kind === "section"
      ? `section:${item.sectionKey}`
      : `pr:${item.pr.url}`;
}

type UseVisualItemsArgs = {
  rows: readonly WorktreeRow[];
  foldedSections: ReadonlySet<string>;
  selectedKey: string | null;
  remoteCreation: RemoteCreation | null;
  remoteWorktrees: readonly RemoteWorktreeSummary[];
  archivedKeys: ReadonlySet<string>;
  githubData?: GithubData;
};

export function useVisualItems({
  rows,
  foldedSections,
  selectedKey,
  remoteCreation,
  remoteWorktrees,
  archivedKeys,
  githubData,
}: UseVisualItemsArgs) {
  const worktrees = useMemo(
    () => buildWorktreeModels(rows, remoteWorktrees, archivedKeys, githubData),
    [rows, remoteWorktrees, archivedKeys, githubData],
  );
  const worktreesByKey = useMemo(
    () => new Map(worktrees.map((model) => [model.key, model])),
    [worktrees],
  );
  // When the selected slug disappears, this ref snaps the cursor to the
  // row that took its place rather than jumping to the top of the list.
  const lastIndexRef = useRef(0);

  const reviewRequests = useQuery(reviewRequestsQuery());
  const reviewRequestRows = useMemo<readonly ReviewRequestPr[]>(
    // A disabled query can still expose a persisted cache entry. The
    // repository switch is authoritative, so suppress that stale section
    // explicitly instead of relying on `enabled: false` alone.
    () => config.github.reviewers ? (reviewRequests.data ?? []) : [],
    [reviewRequests.data],
  );

  const archivedRows = useMemo(() => rows.filter((r) => r.archived), [rows]);
  const archivedRemoteRows = useMemo(
    () =>
      remoteWorktrees.filter((row) =>
        archivedKeys.has(remoteWorktreeLedgerKey(row.hostKey, row.slug)),
      ),
    [remoteWorktrees, archivedKeys],
  );

  // Active portion, with folded sections collapsed to one `section` item each.
  // This is the single source of truth shared by the cursor model and the list.
  const activeItems = useMemo<ListActiveItem[]>(() => {
    return buildActiveItems({
      rows,
      foldedSections,
      remoteCreation,
      remoteWorktrees,
      archivedKeys,
      githubData,
    });
  }, [
    rows,
    foldedSections,
    remoteCreation,
    remoteWorktrees,
    archivedKeys,
    githubData,
  ]);

  const archivedItems = useMemo<ArchivedItem[]>(() => {
    const members: Exclude<ArchivedItem, SelectedSection>[] = [
      ...archivedRows.map((row) => ({
        kind: "wt" as const,
        row,
        target: localWorktreeTarget(row.wt),
        model: worktreesByKey.get(row.wt.slug)!,
      })),
      ...archivedRemoteRows.map((entry) => ({
        kind: "remote" as const,
        entry,
        target: remoteWorktreeTarget(entry),
        model: worktreesByKey.get(
          remoteWorktreeLedgerKey(entry.hostKey, entry.slug),
        )!,
        archived: true as const,
      })),
    ];
    // Folded, the whole block collapses to one header — here rather
    // than in the list, because the cursor model is built from this:
    // painting one line over N cursor stops would leave j/k walking
    // through rows nobody can see.
    if (members.length === 0 || !foldedSections.has(GROUP_ARCHIVED)) return members;
    return [
      {
        kind: "section",
        sectionKey: GROUP_ARCHIVED,
        label: "Archived",
        members,
      },
    ];
  }, [archivedRows, archivedRemoteRows, foldedSections, worktreesByKey]);

  const visualItems = useMemo<VisualItem[]>(() => {
    const prs: VisualItem[] = reviewRequestRows.map((pr) => ({ kind: "pr", pr }));
    return [...activeItems, ...prs, ...archivedItems];
  }, [activeItems, reviewRequestRows, archivedItems]);

  // Resolve the selected key to a visual index. When the key isn't in
  // the current visible set, fall back to the last known visual index,
  // clamped to the new length.
  const lookupIndex =
    selectedKey === null
      ? -1
      : visualItems.findIndex((v) => visualKey(v) === selectedKey);
  const cursorIndex = (() => {
    if (visualItems.length === 0) return -1;
    if (lookupIndex >= 0) return lookupIndex;
    if (selectedKey === null) {
      const firstWt = visualItems.findIndex(
        (v) => v.kind === "wt" || v.kind === "remote",
      );
      if (firstWt >= 0) return firstWt;
      // No worktree/remote row visible (e.g. every section folded):
      // land on the first item of any kind rather than nothing — a
      // fresh boot over folded sections used to show "No worktree
      // selected" until the first j.
      return 0;
    }
    return Math.min(lastIndexRef.current, visualItems.length - 1);
  })();

  const currentItem = cursorIndex >= 0 ? visualItems[cursorIndex] : undefined;
  const current = currentItem?.kind === "wt" ? currentItem.row : undefined;
  const selectedPr = currentItem?.kind === "pr" ? currentItem.pr : undefined;
  const selectedRemote =
    currentItem?.kind === "remote" ? currentItem.entry : undefined;
  const selectedSection =
    currentItem?.kind === "section" ? currentItem : undefined;
  const currentTarget =
    currentItem?.kind === "wt" || currentItem?.kind === "remote"
      ? currentItem.target ?? undefined
      : undefined;
  const currentFleetRow: FleetWorktreeItem | undefined =
    currentItem?.kind === "wt" || currentItem?.kind === "remote"
      ? currentItem
      : undefined;
  const selectedWorktree = currentFleetRow?.model ?? undefined;

  // Render-time write is derived from this render's inputs and mirrors the
  // previous in-app cursor model.
  if (cursorIndex >= 0 && cursorIndex !== lastIndexRef.current) {
    lastIndexRef.current = cursorIndex;
  }

  return {
    activeItems,
    archivedItems,
    reviewRequestRows,
    visualItems,
    cursorIndex,
    currentItem,
    current,
    selectedPr,
    selectedRemote,
    selectedSection,
    currentTarget,
    currentFleetRow,
    selectedWorktree,
    worktrees,
  };
}
