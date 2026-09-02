import type { KeyEvent } from "@opentui/core";

import { actionRegistry } from "../../core/actions.ts";
import { killDiffSessionPromise, killShellSessionPromise } from "../../core/tmux.ts";
import type { Modal } from "../modal-state.ts";
import type { SimpleModalContext } from "./ctx.ts";
import { handleYesNoKey } from "./list-picker.ts";
import { Data, Effect } from "effect";

class ConfirmModalError extends Data.TaggedError("ConfirmModalError")<{
  cause: unknown;
}> {}
const confirmPromise = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new ConfirmModalError({ cause }),
  });

export function handleKillActionConfirmKey(
  k: KeyEvent,
  modal: Extract<Modal, { kind: "killActionConfirm" }>,
  { setModal, logWarn }: SimpleModalContext,
): boolean {
  return handleYesNoKey(k, {
    onConfirm: () => {
      const { slug, actionName } = modal;
      setModal(null);
      Effect.runFork(
        confirmPromise(() => actionRegistry.killPromise(slug)).pipe(
          Effect.tap((killed) =>
            Effect.sync(() => {
              if (killed) logWarn(`killed action "${actionName}" on ${slug}`);
            }),
          ),
          Effect.catch(() => Effect.void),
        ),
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
      const kill = sessionKind === "diff" ? killDiffSessionPromise : killShellSessionPromise;
      Effect.runFork(
        confirmPromise(() => kill(slug)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              logWarn(`killed ${sessionKind} session on ${slug}`);
            }),
          ),
          Effect.andThen(confirmPromise(refreshTmuxSessions)),
          Effect.catch((error) =>
            Effect.sync(() => {
              const msg =
                error.cause instanceof Error
                  ? error.cause.message
                  : String(error.cause);
              logErr(`kill ${sessionKind} session failed for ${slug}: ${msg}`);
            }),
          ),
        ),
      );
    },
    onCancel: () => setModal(null),
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
        Effect.runFork(
          confirmPromise(() => doRemoveWorktree(modal.target!)).pipe(
            Effect.catch((e) => Effect.sync(() => logErr(String(e.cause)))),
          ),
        );
      } else if (pending === "d!" && modal.target) {
        Effect.runFork(
          confirmPromise(() =>
            doRemoveWorktree(modal.target!, { force: true }),
          ).pipe(
            Effect.catch((e) => Effect.sync(() => logErr(String(e.cause)))),
          ),
        );
      } else if (pending === "e" && slug) {
        Effect.runFork(
          confirmPromise(() => doMarkReady(slug)).pipe(
            Effect.catch((e) => Effect.sync(() => logErr(String(e.cause)))),
          ),
        );
      } else if (pending === "E" && slug) {
        Effect.runFork(
          confirmPromise(() => doShipPr(slug)).pipe(
            Effect.catch((e) => Effect.sync(() => logErr(String(e.cause)))),
          ),
        );
      } else if (pending === "review-wt" && modal.reviewBranch) {
        Effect.runFork(
          confirmPromise(() => doCheckoutReview(modal.reviewBranch!)).pipe(
            Effect.catch((e) => Effect.sync(() => logErr(String(e.cause)))),
          ),
        );
      } else if (pending === "restore" && modal.restoreEntry) {
        Effect.runFork(
          confirmPromise(() => doRestoreRemoved(modal.restoreEntry!)).pipe(
            Effect.catch((e) => Effect.sync(() => logErr(String(e.cause)))),
          ),
        );
      } else if (pending === "R") {
        logWarn("cleared all cached data; refetching from scratch");
        Effect.runFork(
          confirmPromise(clearAll).pipe(
            Effect.catch((e) => Effect.sync(() => logErr(String(e.cause)))),
          ),
        );
      }
    },
    onCancel: () => setModal(null),
    extraCancelKeys: confirmCancelKeys(modal.pendingKey),
  });
}
