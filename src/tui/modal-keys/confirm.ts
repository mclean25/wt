import type { KeyEvent } from "@opentui/core";

import { actionRegistry } from "../../core/actions.ts";
import { operationErrors } from "../../core/errors.ts";
import { killDiffSession, killShellSession } from "../../core/tmux.ts";
import { forkReported } from "../effect-boundary.ts";
import type { Modal } from "../modal-state.ts";
import type { SimpleModalContext } from "./ctx.ts";
import { handleYesNoKey } from "./list-picker.ts";
import { Effect } from "effect";

const io = operationErrors("modal-keys/confirm");

export function handleKillActionConfirmKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "killActionConfirm" }>,
  { setModal, logWarn }: SimpleModalContext,
): boolean {
  return handleYesNoKey(k, {
    onConfirm: () => {
      const { slug, actionName } = modal;
      setModal(null);
      forkReported(
        actionRegistry.kill(slug).pipe(
          Effect.tap((killed) =>
            Effect.sync(() => {
              if (killed) logWarn(`killed action "${actionName}" on ${slug}`);
            }),
          ),
        ),
        () => {},
      );
    },
    onCancel: () => setModal(null),
    extraCancelKeys: ["!"],
  });
}

export function handleKillSessionConfirmKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "killSessionConfirm" }>,
  { setModal, refreshTmuxSessions, logWarn, logErr }: SimpleModalContext,
): boolean {
  const { sessionKind } = modal;
  return handleYesNoKey(k, {
    onConfirm: () => {
      const { slug } = modal;
      setModal(null);
      const kill = sessionKind === "diff" ? killDiffSession : killShellSession;
      forkReported(
        kill(slug).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              logWarn(`killed ${sessionKind} session on ${slug}`);
            }),
          ),
          Effect.andThen(io.promise("refresh tmux sessions", refreshTmuxSessions)),
        ),
        (error) =>
          logErr(`kill ${sessionKind} session failed for ${slug}: ${error.message}`),
      );
    },
    onCancel: () => setModal(null),
  });
}

export function handleCleanConfirmKey(
  k: KeyEvent,
  { setModal, doClean, logErr }: SimpleModalContext,
): boolean {
  return handleYesNoKey(k, {
    onConfirm: () => {
      setModal(null);
      forkReported(io.promise("clean", doClean), (error) =>
        logErr(`clean failed: ${error.message}`),
      );
    },
    onCancel: () => setModal(null),
    // `c` opens this modal (global-keys.ts) — toggle-dismiss.
    extraCancelKeys: ["c"],
  });
}

/**
 * The single-letter (or non-letter sequence) key that opened a given
 * `confirm` modal `pendingKey`, for toggle-dismiss — mirrors
 * `killActionConfirm`'s `!`. `restore`
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
    doRemoveWorktree,
    doMarkReady,
    doShipPr,
    doCheckoutReview,
    doRestoreRemoved,
    clearAll,
    logWarn,
    logErr,
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
      if (pending === "d" && modal.target) {
        forkReported(
          io.promise("remove worktree", () => doRemoveWorktree(modal.target!)),
          (e) => logErr(e.message),
        );
      } else if (pending === "d!" && modal.target) {
        forkReported(
          io.promise("remove worktree", () =>
            doRemoveWorktree(modal.target!, { force: true }),
          ),
          (e) => logErr(e.message),
        );
      } else if (pending === "e" && slug) {
        forkReported(
          io.promise("mark ready", () => doMarkReady(slug)),
          (e) => logErr(e.message),
        );
      } else if (pending === "E" && slug) {
        forkReported(
          io.promise("ship PR", () => doShipPr(slug)),
          (e) => logErr(e.message),
        );
      } else if (pending === "review-wt" && modal.reviewBranch) {
        forkReported(
          io.promise("checkout review", () => doCheckoutReview(modal.reviewBranch!)),
          (e) => logErr(e.message),
        );
      } else if (pending === "restore" && modal.restoreEntry) {
        forkReported(
          io.promise("restore removed", () => doRestoreRemoved(modal.restoreEntry!)),
          (e) => logErr(e.message),
        );
      } else if (pending === "R") {
        logWarn("cleared all cached data; refetching from scratch");
        forkReported(io.promise("clear caches", clearAll), (e) => logErr(e.message));
      }
    },
    onCancel: () => setModal(null),
    extraCancelKeys: confirmCancelKeys(modal.pendingKey),
  });
}
