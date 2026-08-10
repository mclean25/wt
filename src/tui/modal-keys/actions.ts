import type { KeyEvent } from "@opentui/core";

import { recentValues } from "../../core/actions.ts";
import { printableMultiline } from "../app-helpers.ts";
import type { Modal } from "../modal-state.ts";
import { applyEditKey, emptyEdit, insertText } from "../text-edit.tsx";
import type { SimpleModalContext } from "./ctx.ts";
import { handleListPickerKey } from "./list-picker.ts";

export function handleActionPickerKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "actionPicker" }>,
  ctx: SimpleModalContext,
): boolean {
  const {
    setModal,
    rows,
    buildActionPickerItems,
    buildManagerPickerItems,
    canPickAction,
    launchAction,
    launchManagerCommand,
    doAutoMerge,
    toast,
    warnColor,
  } = ctx;
  const ap = modal.state;
  const manager = ap.surface === "manager";
  const buildItems = () =>
    manager ? buildManagerPickerItems(ap.rowSlug) : buildActionPickerItems(ap.slug);
  if (ap.mode === "list") {
    const items = buildItems();
    const commitIndex = (i: number): void => {
      const item = items[i];
      if (!item) return;
      if (!canPickAction(item)) return;
      if (item.kind === "autoMerge") {
        // Direct toggle, no confirm — `!` + `m` is already deliberate,
        // matching the `; x` direct-kill convention.
        setModal(null);
        void doAutoMerge(ap.slug, item.armed ? "disable" : "enable");
        return;
      }
      if (manager && item.kind === "action" && item.def.direct) {
        // Direct-launch builtins (the palette's raw `/compact`): the
        // prompt IS the message; an extras screen would be noise. The
        // `manager` gate is load-bearing: this launch path is fleet-
        // only, so a hypothetical future row-surface `direct` builtin
        // must NOT route here (it'd silently address the manager).
        setModal(null);
        void launchManagerCommand(item.def, "");
        return;
      }
      // Fleet defs never take the argPicker: its launch path is
      // row-scoped (`launchAction`), which would either no-op on the
      // manager pseudo-slug or wrongly `[re:]`-prefix a fleet prompt.
      // No fleet builtin declares an argPrompt today; if one ever
      // does, it falls through to the extras editor instead.
      if (
        item.kind === "action" &&
        item.def.argPrompt &&
        !(manager && item.def.fleet)
      ) {
        const history = recentValues(item.def.id);
        setModal({
          kind: "argPicker",
          // Manager surface: arg-prompting defs are row-scoped user
          // actions; launch against the captured row (canPickAction
          // already blocked them when no row was selected).
          slug: manager ? (ap.rowSlug ?? ap.slug) : ap.slug,
          def: item.def,
          history,
          index: 0,
          input: history.length === 0 ? emptyEdit : null,
        });
        return;
      }
      if (item.kind === "action" && item.def.kind === "shell") {
        setModal(null);
        void launchAction(ap.slug, item.def, "");
        return;
      }
      const def = item.kind === "action" ? item.def : null;
      setModal({
        kind: "actionPicker",
        state: {
          mode: "edit",
          surface: ap.surface,
          slug: ap.slug,
          rowSlug: ap.rowSlug,
          def: def && def.kind === "claude" ? def : null,
          extras: emptyEdit,
        },
      });
    };
    // Per-action letter keys (config-assigned) stay a pre-check: they
    // are dynamic per item list, with `c` reserved for the custom
    // prompt. Both follow the same "letter fires directly" convention
    // the shared handler implements for static chords.
    if (k.sequence === "c") {
      setModal({
        kind: "actionPicker",
        state: {
          mode: "edit",
          surface: ap.surface,
          slug: ap.slug,
          rowSlug: ap.rowSlug,
          def: null,
          extras: emptyEdit,
        },
      });
      return true;
    }
    if (k.sequence && /^[a-z]$/.test(k.sequence)) {
      const i = items.findIndex(
        (it) => it.kind !== "custom" && it.key === k.sequence,
      );
      if (i >= 0) {
        commitIndex(i);
        return true;
      }
    }
    return handleListPickerKey(k, {
      count: items.length,
      index: ap.index,
      onMove: (next) =>
        setModal({ kind: "actionPicker", state: { ...ap, index: next } }),
      onCommit: commitIndex,
      onCancel: () => setModal(null),
      confirm: [manager ? "M" : "!"],
      // Actions are picked by their assigned letters, not positions.
      digits: false,
    });
  }

  if (k.ctrl && k.name === "c") {
    setModal(null);
    return true;
  }
  if (k.name === "escape") {
    const def = ap.def;
    if (def) {
      // Manager surface always has a list to return to; the row surface
      // guards against the worktree vanishing while the editor was up.
      if (!manager && !rows.find((r) => r.wt.slug === ap.slug)) {
        setModal(null);
        toast("worktree gone", warnColor, 2000);
        return true;
      }
      const items = buildItems();
      const idx = items.findIndex(
        (it) => it.kind === "action" && it.def.id === def.id,
      );
      setModal({
        kind: "actionPicker",
        state: {
          mode: "list",
          surface: ap.surface,
          slug: ap.slug,
          rowSlug: ap.rowSlug,
          index: Math.max(0, idx),
        },
      });
    } else {
      setModal(null);
    }
    return true;
  }
  if (k.name === "return") {
    const { slug, rowSlug, def, extras } = ap;
    setModal(null);
    if (manager) {
      // Fleet builtins and free-text go straight to the manager; the
      // row-scoped entries (ask-about-row, user `target = "manager"`
      // actions) ride the normal launch path against the captured row
      // so they get template vars and the `[re: <slug>]` prefix.
      if (def === null || def.fleet) void launchManagerCommand(def, extras.value);
      else if (rowSlug) void launchAction(rowSlug, def, extras.value);
      else toast("no row selected", warnColor, 2000);
    } else {
      void launchAction(slug, def, extras.value);
    }
    return true;
  }
  // Cursor movement / deletion — shared editor logic (backspace
  // included; on an empty value it's a no-op, not a close).
  const edited = applyEditKey(k, ap.extras);
  if (edited) {
    setModal({ kind: "actionPicker", state: { ...ap, extras: edited } });
    return true;
  }
  const text = printableMultiline(k.sequence);
  if (text) {
    setModal({
      kind: "actionPicker",
      state: { ...ap, extras: insertText(ap.extras, text) },
    });
  }
  return true;
}

export function handleArgPickerKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "argPicker" }>,
  { setModal, launchAction }: SimpleModalContext,
): boolean {
  const rowCount = modal.history.length + 1;
  const isInput = modal.input !== null;
  const launch = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    setModal(null);
    void launchAction(modal.slug, modal.def, "", trimmed);
  };
  if (k.ctrl && k.name === "c") {
    setModal(null);
    return true;
  }
  if (isInput) {
    if (k.name === "escape") {
      if (modal.history.length > 0) setModal({ ...modal, input: null, index: 0 });
      else setModal(null);
      return true;
    }
    if (k.name === "return") {
      launch(modal.input?.value ?? "");
      return true;
    }
    const edited = applyEditKey(k, modal.input ?? emptyEdit);
    if (edited) {
      setModal({ ...modal, input: edited });
      return true;
    }
    const text = printableMultiline(k.sequence);
    if (text) setModal({ ...modal, input: insertText(modal.input ?? emptyEdit, text) });
    return true;
  }
  return handleListPickerKey(k, {
    count: rowCount,
    index: modal.index,
    onMove: (next) => setModal({ ...modal, index: next }),
    onCommit: (i) => {
      if (i >= modal.history.length) {
        setModal({ ...modal, input: emptyEdit });
        return;
      }
      const entry = modal.history[i];
      if (entry) launch(entry.value);
    },
    onCancel: () => setModal(null),
    // Digits launch history values only — the "+ new value…" row is
    // Enter-only (it opens an input, not a pick).
    digits: (n) => {
      const entry = modal.history[n - 1];
      if (entry) launch(entry.value);
    },
  });
}
