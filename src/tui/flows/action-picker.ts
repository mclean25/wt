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
import { mergeWhenReadyArmed } from "../app-helpers.ts";
import type { Modal } from "../modal-state.ts";
import { assignActionKeys, type PickerItem } from "../panels/action-picker.tsx";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";
import { theme } from "../theme.ts";

/** Quick-pick letter for the `!` picker's auto-merge toggle row. */
const AUTO_MERGE_KEY = "m";
/** Quick-pick letter for the slot palettes' open-in-editor row. */
const OPEN_EDITOR_KEY = "z";

type ActionPickerFlowsCtx = {
  rows: WorktreeRow[];
  setModal: (m: Modal | null) => void;
  toast: (message: string, color?: string, ms?: number) => void;
};

export function makeActionPickerFlows(ctx: ActionPickerFlowsCtx) {
  const { rows, setModal, toast } = ctx;

  function buildActionPickerItems(slug: string): PickerItem[] {
    const row = rows.find((r) => r.wt.slug === slug);
    const rowState = {
      slug,
      pr: row?.pr,
      deployed: row?.fields.deploy.data ?? false,
    };
    // Pinned builtins (dev server) lead, then the user's actions, then
    // the trailing builtins (review-bot re-run).
    const defs = [...PINNED_BUILTIN_ACTIONS, ...config.actions, ...BUILTIN_ACTIONS];
    // `m` is reserved for the auto-merge toggle row below, so key
    // assignment must not hand it to an action (an explicit key = "m"
    // in config falls back to auto-derivation).
    const keyById = assignActionKeys(defs, [AUTO_MERGE_KEY]);
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
    const buckets = new Map<string, typeof actionItems>();
    for (const it of actionItems) {
      const g = it.def.group ?? "";
      const arr = buckets.get(g);
      if (arr) arr.push(it);
      else buckets.set(g, [it]);
    }
    // Auto-merge toggle — the flow that used to live on Shift+M, now a
    // picker row (group "github") so it sits with the other PR-shaped
    // actions and frees `M` for the manager palette. Direct-launch, no
    // confirm: `!` + `m` is already a deliberate two-step.
    const autoMergeItem: PickerItem = {
      kind: "autoMerge",
      key: AUTO_MERGE_KEY,
      armed: mergeWhenReadyArmed(row),
      availability: !row?.pr
        ? { ok: false, reason: "no PR" }
        : row.pr.state !== "OPEN"
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
          : "open in editor";
    toast(`${name}: ${item.availability.reason}`, theme.warn, 2500);
    return false;
  }

  function openActionPicker(slug: string): void {
    setModal({
      kind: "actionPicker",
      state: { mode: "list", surface: "row", slug, rowSlug: null, index: 0 },
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
