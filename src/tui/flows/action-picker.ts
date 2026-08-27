/**
 * Action-picker helpers (`!`), the manager command palette (`M`), and
 * the slot palettes (`<` / `>` / `\`): build the grouped picker item
 * lists, availability gating, and the open helpers. Extracted from
 * `app.tsx`; rebuilt per render so the closures see fresh rows.
 */
import {
  BUILTIN_ACTIONS,
  MANAGER_BUILTIN_ACTIONS,
  PINNED_BUILTIN_ACTIONS,
  SLOT_BUILTIN_ACTIONS,
  evaluateActionRequirements,
} from "../../core/actions.ts";
import { config } from "../../core/config.ts";
import { MANAGER_SLUG } from "../../core/manager.ts";
import { armedFromPr } from "../badges.ts";
import type { Modal } from "../modal-state.ts";
import { assignActionKeys, type PickerItem } from "../panels/action-picker.tsx";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";
import type { WorktreeTarget } from "../../core/worktree-target.ts";
import type { ActionSubjectResolver } from "../action-subject.ts";
import { theme } from "../theme.ts";

/** Quick-pick letter for the `!` picker's auto-merge toggle row. */
const AUTO_MERGE_KEY = "m";
/** Quick-pick letter for the row palette's dev-log overlay. */
const DEV_LOGS_KEY = "l";
/** Quick-pick letter for the slot palettes' open-in-editor row. */
const OPEN_EDITOR_KEY = "z";

type ActionPickerFlowsCtx = {
  rows: WorktreeRow[];
  actionSubjectFor: ActionSubjectResolver;
  setModal: (m: Modal | null) => void;
  toast: (message: string, color?: string, ms?: number) => void;
};

export function makeActionPickerFlows(ctx: ActionPickerFlowsCtx) {
  const { rows, actionSubjectFor, setModal, toast } = ctx;

  function buildActionPickerItems(target: WorktreeTarget): PickerItem[] {
    const slug = target.slug;
    const subject = actionSubjectFor(target);
    const pr = subject?.pr;
    const rowState = {
      slug,
      issueId: subject?.issueId,
      pr,
      deployed: subject?.deployed ?? false,
    };
    // Pinned builtins (dev server) lead, then the user's actions, then
    // the trailing builtins (review-bot re-run).
    const defs = [...PINNED_BUILTIN_ACTIONS, ...config.actions, ...BUILTIN_ACTIONS];
    // `m` and `l` are reserved for the built-in auto-merge and dev-log
    // rows below, so assignment must not hand either to a configured
    // action (an explicit collision falls back to auto-derivation).
    const keyById = assignActionKeys(defs, [AUTO_MERGE_KEY, DEV_LOGS_KEY]);
    const actionItems = defs.map((def) => ({
      kind: "action" as const,
      def,
      key: keyById.get(def.id) ?? "",
      availability: evaluateActionRequirements(def.requires, rowState),
    }));
    // Cluster by group: group order by first appearance, original order
    // within a group, so the picker shows one header per section. Keys
    // are assigned over the unclustered list above so they stay stable
    // regardless of grouping. The custom-prompt entry always trails.
    const buckets = new Map<string, PickerItem[]>();
    for (const it of actionItems) {
      const g = it.def.group ?? "";
      const arr = buckets.get(g);
      if (arr) arr.push(it);
      else buckets.set(g, [it]);
    }
    if (config.devServer) {
      const logsItem: PickerItem = {
        kind: "devLogs",
        key: DEV_LOGS_KEY,
        // A parked crash still owns useful logs. A stopped/never-started
        // server has neither a live pane nor a saved crash report.
        availability:
          subject?.devLogsAvailable
            ? { ok: true }
            : { ok: false, reason: "dev server is not running" },
      };
      const devBucket = buckets.get("dev server");
      if (devBucket) devBucket.push(logsItem);
      else buckets.set("dev server", [logsItem]);
    }
    // Auto-merge toggle — the flow that used to live on Shift+M, now a
    // picker row (group "github") so it sits with the other PR-shaped
    // actions and frees `M` for the manager palette. Direct-launch, no
    // confirm: `!` + `m` is already a deliberate two-step.
    const autoMergeItem: PickerItem = {
      kind: "autoMerge",
      key: AUTO_MERGE_KEY,
      armed: !!pr && armedFromPr(pr, subject?.mq),
      availability: !pr
        ? { ok: false, reason: "no PR" }
        : pr.state !== "OPEN"
          ? { ok: false, reason: "PR is not open" }
          : { ok: true },
    };
    return [
      ...[...buckets.values()].flat(),
      autoMergeItem,
      { kind: "custom" as const },
    ];
  }

  /**
   * The `M` manager palette: fleet-scoped builtins (digest, triage,
   * merge order, …), the row-scoped ask-about entry, any user
   * `[[actions]]` with `target = "manager"` (row-scoped briefings,
   * rendered against the selected row), and the custom free-text
   * entry. `rowSlug` is the selection captured at open time; row-
   * scoped entries gray out when there is none.
   */
  function buildManagerPickerItems(rowSlug: string | null): PickerItem[] {
    const row = rowSlug ? rows.find((r) => r.wt.slug === rowSlug) : undefined;
    const rowState = {
      slug: rowSlug ?? "",
      issueId: row?.issueId,
      pr: row?.pr,
      deployed: row?.fields.deploy.data ?? false,
    };
    const userManagerDefs = config.actions.filter(
      (d) => d.kind === "claude" && d.target === "manager",
    );
    const defs = [...MANAGER_BUILTIN_ACTIONS, ...userManagerDefs];
    const keyById = assignActionKeys(defs);
    const items: PickerItem[] = defs.map((def) => {
      const rowScoped = !def.fleet;
      const availability =
        rowScoped && !row
          ? { ok: false as const, reason: "no row selected" }
          : rowScoped
            ? evaluateActionRequirements(def.requires, rowState)
            : { ok: true as const };
      return {
        kind: "action" as const,
        def,
        key: keyById.get(def.id) ?? "",
        availability,
      };
    });
    return [...items, { kind: "custom" as const }];
  }

  /**
   * A slot palette (`<` / `>` / `\`): the shared slot builtins
   * (continue, compact), the local open-in-editor row, and the custom
   * free-text entry. Uniform across slots — nothing here is row- or
   * slot-specific, so no availability gating.
   */
  function buildSlotPickerItems(): PickerItem[] {
    const keyById = assignActionKeys(SLOT_BUILTIN_ACTIONS, [OPEN_EDITOR_KEY]);
    return [
      ...SLOT_BUILTIN_ACTIONS.map((def) => ({
        kind: "action" as const,
        def,
        key: keyById.get(def.id) ?? "",
        availability: { ok: true as const },
      })),
      { kind: "openEditor" as const, key: OPEN_EDITOR_KEY, availability: { ok: true as const } },
      { kind: "custom" as const },
    ];
  }

  /**
   * Returns true if the item is launchable. For unavailable actions
   * toasts the reason so the user understands the no-op without
   * having to scan the dim subtitle in the picker. Used at both the
   * Enter and quick-pick-letter handlers so an unavailable action
   * can't slip into the edit modal.
   */
  function canPickAction(item: PickerItem): boolean {
    if (item.kind === "custom") return true;
    if (item.availability.ok) return true;
    const name =
      item.kind === "action"
        ? item.def.name
        : item.kind === "autoMerge"
          ? "auto-merge"
          : item.kind === "devLogs"
            ? "dev server logs"
            : "open in editor";
    toast(`${name}: ${item.availability.reason}`, theme.warn, 2500);
    return false;
  }

  function openActionPicker(target: WorktreeTarget): void {
    setModal({
      kind: "actionPicker",
      state: {
        mode: "list",
        surface: "row",
        slug: target.slug,
        rowSlug: null,
        target,
        index: 0,
      },
    });
  }

  /** `M` — the manager command palette. Opens with or without a row. */
  function openManagerPalette(rowSlug: string | null): void {
    setModal({
      kind: "actionPicker",
      state: {
        mode: "list",
        surface: "manager",
        slug: MANAGER_SLUG,
        rowSlug,
        index: 0,
      },
    });
  }

  /** `<` / `>` / `\` — a slot session's command palette. */
  function openSlotPalette(slotSlug: string): void {
    setModal({
      kind: "actionPicker",
      state: {
        mode: "list",
        surface: "slot",
        slug: slotSlug,
        rowSlug: null,
        index: 0,
      },
    });
  }

  return {
    buildActionPickerItems,
    buildManagerPickerItems,
    buildSlotPickerItems,
    canPickAction,
    openActionPicker,
    openManagerPalette,
    openSlotPalette,
  };
}
