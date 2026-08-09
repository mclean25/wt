import type { KeyEvent } from "@opentui/core";

import { actionRegistry } from "../../core/actions.ts";
import { getHarness } from "../../core/harness/index.ts";
import { killDiffSession, killHarnessSession, killShellSession } from "../../core/tmux.ts";
import type { Modal } from "../modal-state.ts";
import type { SimpleModalContext } from "./ctx.ts";
import { handleYesNoKey } from "./list-picker.ts";

export function handleKillActionConfirmKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "killActionConfirm" }>,
  { setModal, logWarn }: SimpleModalContext,
): boolean {
  return handleYesNoKey(k, {
    onConfirm: () => {
      const { slug, actionName } = modal;
      setModal(null);
      void actionRegistry.kill(slug).then((killed) => {
        if (killed) logWarn(`killed action "${actionName}" on ${slug}`);
      });
    },
    onCancel: () => setModal(null),
    extraCancelKeys: ["!"],
  });
}

export function handleKillSessionConfirmKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "killSessionConfirm" }>,
  {
    setModal,
    refreshTmuxSessions,
    refreshHarnessSessions,
    doKillClaudeSession,
    logWarn,
    logErr,
  }: SimpleModalContext,
): boolean {
  const { sessionKind } = modal;
  // The shell/diff variants have no single-key opener (Shift+F10/F11
  // are chords, not a bare trigger this modal can re-press to
  // dismiss); the harness variant opens via `x` on a live session
  // row, so `x` toggle-dismisses it like every other single-trigger
  // picker/confirm.
  const isHarness =
    sessionKind === "claude" || sessionKind === "codex" || sessionKind === "opencode";
  return handleYesNoKey(k, {
    onConfirm: () => {
      const { slug } = modal;
      setModal(null);
      if (sessionKind === "claude") {
        // doKillClaudeSession owns its own optimistic-remove, refresh,
        // and event log — mirrors exactly what the inline `x` handler
        // in modal-keys/sessions.ts did before this modal gated it.
        doKillClaudeSession(slug, modal.managedName);
        return;
      }
      if (sessionKind === "codex" || sessionKind === "opencode") {
        void (async () => {
          await killHarnessSession(slug, sessionKind);
          await Promise.all([refreshTmuxSessions(), refreshHarnessSessions(slug)]);
          logWarn(`killed ${getHarness(sessionKind).label} session on ${slug}`);
        })().catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          logErr(`kill ${sessionKind} session failed for ${slug}: ${msg}`);
        });
        return;
      }
      const kill = sessionKind === "diff" ? killDiffSession : killShellSession;
      void kill(slug)
        .then(() => {
          logWarn(`killed ${sessionKind} session on ${slug}`);
          void refreshTmuxSessions();
        })
        .catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          logErr(`kill ${sessionKind} session failed for ${slug}: ${msg}`);
        });
    },
    onCancel: () => setModal(null),
    extraCancelKeys: isHarness ? ["x"] : undefined,
  });
}

export function handleCleanConfirmKey(
  k: KeyEvent,
  { setModal, doClean }: SimpleModalContext,
): boolean {
  return handleYesNoKey(k, {
    onConfirm: () => {
      setModal(null);
      void doClean();
    },
    onCancel: () => setModal(null),
    // `c` opens this modal (global-keys.ts) — toggle-dismiss.
    extraCancelKeys: ["c"],
  });
}

/**
 * The single-letter (or non-letter sequence) key that opened a given
 * `confirm` modal `pendingKey`, for toggle-dismiss — mirrors
 * `killActionConfirm`'s `!` and `killSessionConfirm`'s `x`. `restore`
 * opens via Enter (removed-view-keys.ts) and `R` via Ctrl+R
 * (global-keys.ts) — neither has a bare-sequence opener distinguishable
 * from the universal confirm/cancel keys here, so they fall back to
 * the universal esc/q/ctrl+c cancels only rather than guessing.
 */
function confirmCancelKeys(pendingKey: string): readonly string[] | undefined {
  switch (pendingKey) {
    case "d":
    case "d!":
    case "remote-d":
    case "remote-d!":
      return ["d"];
    case "e":
      return ["e"];
    case "E":
      return ["E"];
    case "m+":
    case "m-":
      return ["M"];
    case "review-wt":
      return ["w"];
    default:
      return undefined;
  }
}

export function handleConfirmKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "confirm" }>,
  ctx: SimpleModalContext,
): boolean {
  const {
    setModal,
    doRemove,
    doRemoteRemove,
    doAutoMerge,
    doMarkReady,
    doShipPr,
    doCheckoutReview,
    doRestoreRemoved,
    clearAll,
    logWarn,
  } = ctx;
  return handleYesNoKey(k, {
    onConfirm: () => {
      const pending = modal.pendingKey;
      setModal(null);
      // Row-scoped confirms act on the slug CAPTURED when the modal opened,
      // not the live `current`: a background refetch can drop the original
      // row while the modal is up, silently re-pointing `current` at a
      // different worktree/PR (the modal text still names the first). The
      // flows tolerate a slug whose row has since vanished — doRemove no-ops
      // on an unknown slug, the gh flows surface a clear error.
      const slug = modal.slug;
      if (pending === "d" && slug) {
        void doRemove(slug);
      } else if (pending === "d!" && slug) {
        void doRemove(slug, { force: true });
      } else if (pending === "remote-d" && modal.remoteSlug) {
        void doRemoteRemove(modal.remoteSlug);
      } else if (pending === "remote-d!" && modal.remoteSlug) {
        void doRemoteRemove(modal.remoteSlug, { force: true });
      } else if (pending === "m+" && slug) {
        void doAutoMerge(slug, "enable");
      } else if (pending === "m-" && slug) {
        void doAutoMerge(slug, "disable");
      } else if (pending === "e" && slug) {
        void doMarkReady(slug);
      } else if (pending === "E" && slug) {
        void doShipPr(slug);
      } else if (pending === "review-wt" && modal.reviewBranch) {
        void doCheckoutReview(modal.reviewBranch);
      } else if (pending === "restore" && modal.restoreEntry) {
        void doRestoreRemoved(modal.restoreEntry);
      } else if (pending === "R") {
        logWarn("cleared all cached data; refetching from scratch");
        void clearAll();
      }
    },
    onCancel: () => setModal(null),
    extraCancelKeys: confirmCancelKeys(modal.pendingKey),
  });
}
