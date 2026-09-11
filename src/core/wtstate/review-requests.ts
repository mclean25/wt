import { readWtState, withWtStateLock, writeWtState } from "./io.ts";
import type { ReviewRequestDismissal } from "./types.ts";

const MAX_REVIEW_REQUEST_DISMISSALS = 200;

/**
 * Replace any older dismissal for this PR and retain a bounded recent ledger.
 * The updated-at fingerprint makes each entry inert as soon as the PR changes.
 */
export function addReviewRequestDismissal(
  dismissals: readonly ReviewRequestDismissal[],
  dismissal: ReviewRequestDismissal,
): ReviewRequestDismissal[] {
  return [
    ...dismissals.filter((entry) => entry.url !== dismissal.url),
    dismissal,
  ].slice(-MAX_REVIEW_REQUEST_DISMISSALS);
}

export function dismissReviewRequest(url: string, updatedAt: string): void {
  withWtStateLock(() => {
    const state = readWtState();
    const dismissal: ReviewRequestDismissal = {
      url,
      updatedAt,
      dismissedAt: new Date().toISOString(),
    };
    writeWtState({
      ...state,
      reviewRequestDismissals: addReviewRequestDismissal(
        state.reviewRequestDismissals,
        dismissal,
      ),
    });
  });
}
