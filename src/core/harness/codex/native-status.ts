import type { DerivedState } from "../status.ts";
import type { HarnessSession } from "../types.ts";

/** Flags currently published by Codex's app-server ThreadStatus schema. */
export type CodexThreadActiveFlag =
  | "waitingOnApproval"
  | "waitingOnUserInput";

/**
 * App-server's ThreadStatus wire shape. The open string member is
 * intentional: wt may be newer or older than the daemon it connects to and
 * must fail honestly when Codex adds a status or active flag.
 */
export type CodexThreadStatus =
  | { readonly type: "notLoaded" }
  | { readonly type: "idle" }
  | { readonly type: "systemError" }
  | {
      readonly type: "active";
      readonly activeFlags: readonly (CodexThreadActiveFlag | (string & {}))[];
    }
  | {
      readonly type: string;
      readonly activeFlags?: readonly string[];
    };

/** Batched native state for one Codex thread. */
export type CodexNativeThreadSnapshot = {
  readonly status: CodexThreadStatus;
  readonly queued: number;
};

export type CodexNativeDerivedStatus = {
  readonly derivedState: DerivedState;
  readonly waitingFor: string | null;
};

function activeFlags(status: CodexThreadStatus): readonly string[] {
  if (status.type !== "active") return [];
  return Array.isArray(status.activeFlags) ? status.activeFlags : [];
}

/**
 * Convert app-server state to wt's cross-harness vocabulary.
 *
 * `null` means the native signal is unavailable or the thread is not loaded,
 * so callers retain the rollout-derived state. An error or a future status is
 * different: app-server did answer, but wt cannot safely call it idle.
 */
export function deriveCodexNativeStatus(
  status: CodexThreadStatus | null | undefined,
): CodexNativeDerivedStatus | null {
  if (status == null || status.type === "notLoaded") return null;

  if (status.type === "idle") {
    return { derivedState: "waiting", waitingFor: null };
  }

  if (status.type === "systemError") {
    return { derivedState: "unknown", waitingFor: null };
  }

  if (status.type !== "active") {
    return { derivedState: "unknown", waitingFor: null };
  }

  const flags = activeFlags(status);
  const approval = flags.includes("waitingOnApproval");
  const userInput = flags.includes("waitingOnUserInput");
  if (approval || userInput) {
    const waitingFor = approval
      ? userInput
        ? "approval or question prompt"
        : "approval prompt"
      : "question prompt";
    return { derivedState: "asking", waitingFor };
  }

  if (
    flags.some(
      (flag) =>
        flag !== "waitingOnApproval" && flag !== "waitingOnUserInput",
    )
  ) {
    return { derivedState: "unknown", waitingFor: null };
  }

  return { derivedState: "working", waitingFor: null };
}

function safeQueueCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Enrich rollout-discovered sessions with one batched app-server snapshot.
 * Map keys are authoritative Codex UUIDs, never wt's display/managed names.
 */
export function enrichCodexSessionsWithNativeStatus(
  sessions: readonly HarnessSession[],
  nativeBySessionId: ReadonlyMap<string, CodexNativeThreadSnapshot>,
): HarnessSession[] {
  return sessions.map((session) => {
    const native = nativeBySessionId.get(session.sessionId);
    if (!native) return session;

    const derived = deriveCodexNativeStatus(native.status);
    return {
      ...session,
      extras: {
        ...session.extras,
        queued: safeQueueCount(native.queued),
        ...(derived ?? {}),
      },
    };
  });
}
