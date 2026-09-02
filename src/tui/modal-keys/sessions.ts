import type { KeyEvent } from "@opentui/core";

import {
  nextAutoName,
  removeClaudeName,
  validateSessionName,
} from "../../core/harness/claude/names.ts";
import {
  getHarness,
  HARNESSES,
  type HarnessId,
} from "../../core/harness/index.ts";
import { sessionOutputId } from "../../core/outputs.ts";
import {
  closeHarnessSessionGracefully,
  killHarnessSession,
} from "../../core/tmux.ts";
import { isBareShiftedKey } from "../app-helpers.ts";
import type { Modal } from "../modal-state.ts";
import { applyEditKey, emptyEdit, insertText } from "../text-edit.tsx";
import { previewFocusPatch } from "../picker-preview.ts";
import { isSyntheticLiveSessionId } from "../hooks/useHarnessSessions.ts";
import type { SimpleModalContext } from "./ctx.ts";
import { handleListPickerKey } from "./list-picker.ts";
import { Data, Duration, Effect } from "effect";

class SessionsModalError extends Data.TaggedError("SessionsModalError")<{
  cause: unknown;
}> {}
const modalPromise = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new SessionsModalError({ cause }),
  });

export function handleClaudeSessionsPickerKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "claudeSessionsPicker" }>,
  ctx: SimpleModalContext,
): boolean {
  const {
    setModal,
    pickerRows,
    setFocus,
    doEnterHarnessSession,
    doKillClaudeSession,
    refreshTmuxSessions,
    refreshHarnessSessions,
    refreshClaudeSummaries,
    toast,
    reportActionError,
    fgDimColor,
    logInfo,
    logWarn,
    logErr,
  } = ctx;
  const slug = modal.slug;
  const rowsLocal = pickerRows;
  const totalRows = rowsLocal.length;
  const idx = Math.min(Math.max(0, modal.index), Math.max(0, totalRows - 1));
  const previewIdFor = (i: number): string | null => {
    const r = rowsLocal[i];
    if (!r || r.kind !== "session") return null;
    if (!r.entry.isLive) return null;
    if (r.entry.harnessId !== "claude") return null;
    return sessionOutputId(slug, "claude", r.entry.extras.managedName);
  };
  const moveTo = (next: number): void => {
    setModal({ ...modal, index: next });
    const patch = previewFocusPatch(previewIdFor(next));
    if (patch) setFocus(slug, patch);
  };
  const openNewClaude = (): void => {
    setModal({
      kind: "claudeSessionsNew",
      slug,
      input: emptyEdit,
      error: null,
    });
  };
  const commitRow = (i: number): void => {
    const r = rowsLocal[i];
    if (!r) return;
    if (r.kind === "new") {
      if (r.harnessId === "claude") openNewClaude();
      else {
        setModal(null);
        doEnterHarnessSession(slug, r.harnessId, { freshSlot: true });
      }
      return;
    }
    const e = r.entry;
    const isSyntheticLive = isSyntheticLiveSessionId(e.sessionId);
    const resumeSessionId = e.isLive || isSyntheticLive ? null : e.sessionId;
    const freshSlot =
      getHarness(e.harnessId).singleSlot && resumeSessionId !== null;
    setModal(null);
    doEnterHarnessSession(slug, e.harnessId, {
      managedName: e.extras.managedName,
      resumeSessionId,
      freshSlot,
    });
  };
  const jumpToNew = (harnessId: HarnessId): void => {
    const target = rowsLocal.findIndex(
      (r) => r.kind === "new" && r.harnessId === harnessId,
    );
    if (target >= 0) moveTo(target);
  };
  if (k.sequence === "x" && !k.ctrl && !k.meta) {
    const r = rowsLocal[idx];
    if (r?.kind === "session") {
      const e = r.entry;
      // Kills fire DIRECTLY — no confirm modal. Reaching this row
      // already took two deliberate steps (`;` then navigating/`x`),
      // and the kill is narrated on the event feed. The Shift+F10/F11
      // shell/diff kills keep their confirm (single-chord openers).
      if (e.harnessId === "claude") {
        if (e.isLive) {
          // doKillClaudeSession owns its own optimistic-remove,
          // refresh, and event log.
          doKillClaudeSession(slug, e.extras.managedName);
          setModal(null);
        } else {
          // Ghost cleanup (forgetting a dead session's stored name)
          // — forgetting a dead name is harmless.
          if (e.extras.managedName !== null) {
            removeClaudeName(slug, e.extras.managedName);
            Effect.runFork(
              modalPromise(() => refreshClaudeSummaries(slug)).pipe(
                Effect.catchAll((error) =>
                  Effect.sync(() =>
                    reportActionError("refresh summaries", error.cause),
                  ),
                ),
              ),
            );
            logInfo(
              `forgot ghost session "${e.extras.managedName}" on ${slug}`,
            );
          }
          setModal(null);
        }
      } else if (e.isLive) {
        const harnessId = e.harnessId;
        setModal(null);
        Effect.runFork(
          Effect.gen(function* () {
            yield* modalPromise(() => killHarnessSession(slug, harnessId));
            yield* Effect.all(
              [
                modalPromise(refreshTmuxSessions),
                modalPromise(() => refreshHarnessSessions(slug)),
              ],
              { concurrency: "unbounded", discard: true },
            );
            yield* Effect.sync(() =>
              logWarn(
                `killed ${getHarness(harnessId).label} session on ${slug}`,
              ),
            );
          }).pipe(
            Effect.catchAll((error) =>
              Effect.sync(() => {
                const msg =
                  error.cause instanceof Error
                    ? error.cause.message
                    : String(error.cause);
                logErr(`kill ${harnessId} session failed for ${slug}: ${msg}`);
              }),
            ),
          ),
        );
      } else {
        toast(
          `${getHarness(e.harnessId).label} session is dead; remove via ${e.harnessId} CLI`,
          fgDimColor,
          2000,
        );
      }
      return true;
    }
  }
  if (k.sequence === "d" && !k.ctrl && !k.meta) {
    const r = rowsLocal[idx];
    if (r?.kind === "session") {
      const e = r.entry;
      if (!e.isLive) {
        toast("session isn't live, nothing to close", fgDimColor, 1500);
        return true;
      }
      logInfo(`closing ${getHarness(e.harnessId).label} session on ${slug}`);
      Effect.runFork(
        modalPromise(() =>
          closeHarnessSessionGracefully(
            slug,
            e.harnessId,
            e.extras.managedName,
          ),
        ).pipe(
          Effect.andThen(Effect.sleep(Duration.millis(800))),
          Effect.andThen(
            Effect.all(
              [
                modalPromise(refreshTmuxSessions),
                modalPromise(() => refreshHarnessSessions(slug)),
              ],
              { concurrency: "unbounded", discard: true },
            ),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() => reportActionError("close session", error.cause)),
          ),
        ),
      );
      setModal(null);
    }
    return true;
  }
  for (const h of HARNESSES) {
    if (k.sequence === h.letter && !k.shift && !k.ctrl && !k.meta) {
      jumpToNew(h.id);
      return true;
    }
  }
  return handleListPickerKey(k, {
    count: totalRows,
    index: idx,
    onMove: moveTo,
    onCommit: commitRow,
    onCancel: () => setModal(null),
    confirm: [";"],
    // Digits count SESSION rows only — the "new …" affordances keep
    // their harness letters.
    digits: (n) => {
      let cursor = 0;
      for (let i = 0; i < rowsLocal.length; i++) {
        if (rowsLocal[i]!.kind !== "session") continue;
        if (cursor === n - 1) {
          commitRow(i);
          return;
        }
        cursor++;
      }
    },
  });
}

export function handleClaudeSessionsNewKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "claudeSessionsNew" }>,
  { setModal, doSpawnNamedClaudeSession }: SimpleModalContext,
): boolean {
  if (k.name === "escape") {
    setModal({ kind: "claudeSessionsPicker", slug: modal.slug, index: 0 });
    return true;
  }
  if (k.ctrl && k.name === "c") {
    setModal(null);
    return true;
  }
  if (k.name === "return") {
    const trimmed = modal.input.value.trim();
    const name = trimmed === "" ? nextAutoName(modal.slug) : trimmed;
    const err = validateSessionName(name);
    if (err) {
      setModal({ ...modal, error: err });
      return true;
    }
    setModal(null);
    doSpawnNamedClaudeSession(modal.slug, name);
    return true;
  }
  // Backspace on empty input backs out to the picker.
  if (k.name === "backspace" && modal.input.value.length === 0) {
    setModal({ kind: "claudeSessionsPicker", slug: modal.slug, index: 0 });
    return true;
  }
  // Cursor movement / deletion — shared editor logic.
  const edited = applyEditKey(k, modal.input);
  if (edited) {
    setModal({ ...modal, input: edited, error: null });
    return true;
  }
  if (k.sequence && /^[a-zA-Z0-9_-]$/.test(k.sequence)) {
    setModal({
      ...modal,
      input: insertText(modal.input, k.sequence),
      error: null,
    });
  }
  return true;
}

export function handleHarnessSelectKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "harnessSelect" }>,
  {
    setModal,
    doSpawnNamedClaudeSession,
    doEnterHarnessSession,
  }: SimpleModalContext,
): boolean {
  const idx = Math.min(Math.max(0, modal.index), HARNESSES.length - 1);
  const slug = modal.slug;
  const commit = (chosen: HarnessId): void => {
    setModal(null);
    if (chosen === "claude") {
      doSpawnNamedClaudeSession(slug, nextAutoName(slug));
    } else {
      doEnterHarnessSession(slug, chosen, {});
    }
  };
  const letterMatch = HARNESSES.find(
    (h) => k.sequence === h.letter && !k.shift && !k.ctrl && !k.meta,
  );
  if (letterMatch) {
    commit(letterMatch.id);
    return true;
  }
  // F12 confirms too — the picker opens from Shift+F12, so the bare
  // spawn key doubles as "yes, this one".
  if (k.name === "f12" && !k.shift) {
    commit(HARNESSES[idx]!.id);
    return true;
  }
  // Shift+F12-again also confirms — the trigger-key re-press
  // convention (docs/architecture.md#modal-ux-rules), matched against
  // the same detection normal-keys.ts uses to open this picker.
  if (isBareShiftedKey(k, "f12")) {
    commit(HARNESSES[idx]!.id);
    return true;
  }
  return handleListPickerKey(k, {
    count: HARNESSES.length,
    index: idx,
    onMove: (next) => setModal({ ...modal, index: next }),
    onCommit: (i) => commit(HARNESSES[i]!.id),
    onCancel: () => setModal(null),
  });
}
