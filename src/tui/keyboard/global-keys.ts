/**
 * App-level keys that work in BOTH list views — the normal worktree
 * list and the removed-worktrees history (`h`). Anything keyed off the
 * selected row / section / PR stays in the normal-mode handler; this is
 * only the stuff with no per-row context: help, quit, refresh, cache
 * clear, new/clean, the global automations pause, the primary-harness
 * cycle, and the slot sessions / editor opens. Extracted from `app.tsx`.
 */
import type { KeyEvent } from "@opentui/core";

import { getHarness, type HarnessId } from "../../core/harness/index.ts";
import { createLogger } from "../../core/logger.ts";
import { isPlainLetter, isShiftedLetter } from "../app-helpers.ts";
import { openInEditor } from "../../core/editor.ts";
import type { Modal } from "../modal-state.ts";
import type { FooterMode } from "../panels/footer.tsx";
import { emptyEdit } from "../text-edit.tsx";
import {
  DOTFILES_SLOT,
  dotfilesSlotAvailable,
  MAIN_CLONE_SLOT,
  MANAGER_SLOT,
  WT_SOURCE_SLOT,
  type SessionSlot,
} from "../sessions/slots.ts";
import { theme } from "../theme.ts";
import type { CleanCandidate } from "../clean-candidate.ts";
import { config } from "../../core/config.ts";
import { Data, Effect } from "effect";

class GlobalKeyError extends Data.TaggedError("GlobalKeyError")<{
  cause: unknown;
}> {}
const keyPromise = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new GlobalKeyError({ cause }),
  });

const appLog = createLogger("[app]");
const newLog = createLogger("[new]");

export type GlobalKeysCtx = {
  setModal: (m: Modal | null) => void;
  quit: () => void;
  refreshAll: () => Promise<void>;
  setFooter: (f: FooterMode) => void;
  cleanCandidates: readonly CleanCandidate[];
  toast: (message: string, color?: string, ms?: number) => void;
  reportActionError: (label: string, err: unknown) => void;
  automations: { configured: boolean; togglePaused: () => Promise<boolean> };
  cyclePrimaryHarness: () => Promise<HarnessId>;
  doEnterSlotSession: (slot: SessionSlot) => void;
  /** `M` — the manager command palette (works with or without a row). */
  openManagerPalette: () => void;
  /** `<` / `>` / `\` — a slot session's command palette. */
  openSlotPalette: (slotSlug: string) => void;
};

export function handleGlobalKey(k: KeyEvent, ctx: GlobalKeysCtx): boolean {
  const {
    setModal,
    quit,
    refreshAll,
    setFooter,
    cleanCandidates,
    toast,
    reportActionError,
    automations,
    cyclePrimaryHarness,
    doEnterSlotSession,
    openManagerPalette,
    openSlotPalette,
  } = ctx;
  if (k.sequence === "?") {
    setModal({ kind: "help", query: emptyEdit, searching: false });
    return true;
  }
  // Shift+P — the perf overlay. Sampling is gated on this modal being
  // open (see perfSnapshotQuery), so opening it starts the 2s poll and
  // closing it stops it; nothing samples in the background.
  //
  // `isShiftedLetter`, not `k.sequence === "P"`: inside tmux the
  // csi-u encoding turns Shift+letter into an escape sequence that
  // never compares equal to the literal.
  if (isShiftedLetter(k, "p")) {
    setModal({ kind: "perf", inject: { kind: "idle" } });
    return true;
  }
  if (isPlainLetter(k, "q") || (k.ctrl && k.name === "c")) {
    quit();
    return true;
  }
  if (k.sequence === "r") {
    // File-only: a manual refresh is worth a grep-able marker (it
    // explains the fetch burst that follows in the log) but not a
    // pane line — the toast below is the keystroke's ONLY surfaced
    // ack, per the toast contract (acks are toast-only, never fed to
    // the pane).
    appLog.info("manual refresh");
    // Refetches don't always produce a visible change (already fresh,
    // or the row just doesn't move) — ack the keystroke so `r` doesn't
    // look like a no-op.
    toast("refreshing", theme.fgDim, 800);
    Effect.runFork(
      keyPromise(refreshAll).pipe(
        Effect.catch((error) =>
          Effect.sync(() => reportActionError("refresh", error.cause)),
        ),
      ),
    );
    return true;
  }
  // Ctrl+R: clear all caches. Moved off bare R when R lost its
  // single-letter slot; same confirm flow, same handler.
  if (k.ctrl && k.name === "r") {
    setModal({
      kind: "confirm",
      pendingKey: "R",
      title: "clear caches",
      message: "Clear all cached data and refetch from scratch?",
      confirmLabel: "clear",
    });
    return true;
  }
  if (k.ctrl && k.name === "n") {
    const remote = config.remote;
    if (!remote) {
      toast("[remote] is not configured", theme.warn, 2200);
      return true;
    }
    newLog.event.dim(`creating on ${remote.label}`);
    setFooter({
      kind: "input",
      prompt: `new@${remote.label}:`,
      edit: emptyEdit,
      purpose: "new-remote",
    });
    return true;
  }
  if (k.sequence === "n") {
    newLog.event.dim(
      "tip: --any to match any author, --base <ref> to branch off",
    );
    setFooter({
      kind: "input",
      prompt: "new:",
      edit: emptyEdit,
      purpose: "new",
    });
    return true;
  }
  if (isPlainLetter(k, "c")) {
    if (cleanCandidates.length === 0) {
      toast("nothing to clean", theme.fgDim, 1500);
      return true;
    }
    setModal({ kind: "cleanConfirm" });
    return true;
  }
  // Shift+A — pause / resume ALL automations. Persisted in wtstate,
  // so the pause survives restarts. The pending intent queue is
  // dropped on pause; conditions that still hold re-derive it on
  // resume.
  if (isShiftedLetter(k, "a")) {
    if (!automations.configured) {
      toast("no [[automations]] configured", theme.fgDim, 2000);
      return true;
    }
    Effect.runFork(
      keyPromise(automations.togglePaused).pipe(
        Effect.tap((nowPaused) =>
          Effect.sync(() => {
            toast(
              nowPaused ? "automations paused" : "automations resumed",
              nowPaused ? theme.warn : theme.ok,
              2000,
            );
          }),
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            reportActionError("automations toggle", error.cause),
          ),
        ),
      ),
    );
    return true;
  }
  // Shift+TAB — cycle the primary harness selection. Re-rendered top-
  // right indicator reflects the new primary; subsequent F12 spawns
  // pick it up.
  if (
    k.name === "tab" &&
    k.shift &&
    !k.ctrl &&
    !k.option &&
    !k.super &&
    !k.hyper &&
    !k.meta
  ) {
    Effect.runFork(
      keyPromise(cyclePrimaryHarness).pipe(
        Effect.tap((next) =>
          Effect.sync(() =>
            appLog.event.info(`primary harness → ${getHarness(next).label}`),
          ),
        ),
        Effect.catch((error) =>
          Effect.sync(() => reportActionError("cycle harness", error.cause)),
        ),
      ),
    );
    return true;
  }
  // Toggle into a persistent harness session for a session slot —
  // `,` is the wt source repo (config/self edits), `.` is the
  // configured main clone, `/` the dotfiles. Same model as F12 on a
  // worktree row: tmux's `new-session -A` makes re-entry idempotent,
  // and F12 (bound to detach-client in the wt-private tmux config)
  // takes the user back out. The selected primary harness (TAB to
  // cycle) is the spawned kind, mirroring how row F12 picks a harness.
  if (k.sequence === ",") {
    doEnterSlotSession(WT_SOURCE_SLOT);
    return true;
  }
  if (k.sequence === ".") {
    doEnterSlotSession(MAIN_CLONE_SLOT);
    return true;
  }
  // Falls through to the normal-key handlers when there's no dotfiles
  // repo, so `/` stays free on machines that never had this slot.
  if (k.sequence === "/" && dotfilesSlotAvailable) {
    doEnterSlotSession(DOTFILES_SLOT);
    return true;
  }
  // `m` — the manager session (fleet coordinator). Global like the
  // other slots. `M` opens the manager command palette (auto-merge,
  // which once lived on M, is now a `!` picker row).
  if (isPlainLetter(k, "m")) {
    doEnterSlotSession(MANAGER_SLOT);
    return true;
  }
  if (isShiftedLetter(k, "m")) {
    openManagerPalette();
    return true;
  }
  // Slot command palettes — the shift analog of each slot's attach
  // key (`<` for `,`, `>` for `.`), except dotfiles: shift+`/` is
  // `?` (help), so it rides `\` — the other slash, same key family.
  // `>` used to open the wt source in the editor; that moved into the wt
  // palette's `z` row (`O` still opens the main clone directly).
  if (k.sequence === "<") {
    openSlotPalette(WT_SOURCE_SLOT.slug);
    return true;
  }
  if (k.sequence === ">") {
    openSlotPalette(MAIN_CLONE_SLOT.slug);
    return true;
  }
  if (k.sequence === "\\" && dotfilesSlotAvailable) {
    openSlotPalette(DOTFILES_SLOT.slug);
    return true;
  }
  if (k.sequence === "O") {
    const slotLog = createLogger(MAIN_CLONE_SLOT.label);
    Effect.runFork(
      keyPromise(() => openInEditor(MAIN_CLONE_SLOT.path)).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            slotLog.event.info(`opened ${MAIN_CLONE_SLOT.path}`),
          ),
        ),
        Effect.catch((error) =>
          Effect.sync(() =>
            slotLog.event.err(
              `editor open failed: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
            ),
          ),
        ),
      ),
    );
    return true;
  }
  return false;
}
