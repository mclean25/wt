import type { ActionDef } from "../core/actions.ts";
import type { HistoryEntry } from "../core/actions.ts";
import type { WorkState } from "../core/work-status.ts";
import type { RemovedWorktree } from "../core/wtstate.ts";
import type { ActionPickerState } from "./panels/action-picker.tsx";
import type { ErrorInjectState } from "./panels/error-overlay.tsx";
import type { PerfInjectState } from "./panels/perf.tsx";
import type { MultiPickerItem } from "./panels/picker.tsx";
import type { SectionPickerItem } from "./panels/section-picker.tsx";
import type { TextEdit } from "./text-edit.tsx";

/**
 * Every overlay/modal the TUI can display. Exactly one is active at a
 * time (or `null`); keyboard handling dispatches by `kind` and JSX renders by
 * `kind`.
 */
export type Modal =
  | { kind: "help"; query: TextEdit; searching: boolean }
  /**
   * Live perf overlay (`P`). `inject` tracks the `i` send-to-wt-session
   * flow, which takes seconds (the harness has to settle before the
   * paste lands) and so needs visible in-progress / failed states.
   */
  | { kind: "perf"; inject: PerfInjectState }
  /**
   * Auto-popping unhandled-error overlay. No opening key — it pops when
   * the capture ring (`tui/error-store.ts`) records an error and no
   * other modal is up (`useErrorOverlayAutoPop` queues it otherwise).
   * `inject` tracks the `i` send-to-wt-session flow, same as perf's.
   */
  | { kind: "errors"; inject: ErrorInjectState }
  | { kind: "cleanConfirm" }
  | {
      kind: "confirm";
      pendingKey: string;
      title: string;
      message: string;
      detail?: string;
      confirmLabel?: string;
      danger?: boolean;
      /**
       * Worktree slug the confirm targets, captured at open time for the
       * row-scoped pendingKeys (`d`/`d!`/`e`/`E`). The dispatch
       * MUST act on this, not the live-selected `current`: while the modal
       * is open a background refetch can drop the original row from the
       * list, and `current` then silently resolves to whatever row now
       * occupies its slot — confirming would fire the destroy/ship/merge
       * at the wrong worktree while the modal text still names the first.
       */
      slug?: string;
      reviewBranch?: string;
      /** Remote target for the `remote-d` / `remote-d!` pending keys. */
      remoteSlug?: string;
      /** Payload for the `restore` pendingKey (removed-worktrees view). */
      restoreEntry?: RemovedWorktree;
    }
  | { kind: "yank"; index: number }
  | {
      kind: "branchPicker";
      title: string;
      items: string[];
      index: number;
      resolve: (picked: string | null) => void;
    }
  | {
      kind: "basePicker";
      slug: string;
      items: Array<{ label: string; branch: string | null }>;
      index: number;
    }
  | {
      kind: "statusPicker";
      slug: string;
      items: Array<{ label: string; state: WorkState | null }>;
      index: number;
    }
  | {
      kind: "reviewerPicker";
      title: string;
      items: MultiPickerItem[];
      index: number;
      checked: Set<string>;
      original: Set<string>;
      slug: string;
      prNumber: number;
    }
  | {
      kind: "sectionPicker";
      title: string;
      slug: string;
      items: SectionPickerItem[];
      index: number;
      newName: TextEdit | null;
    }
  | { kind: "actionPicker"; state: ActionPickerState }
  | {
      kind: "argPicker";
      slug: string;
      def: ActionDef;
      history: readonly HistoryEntry[];
      index: number;
      input: TextEdit | null;
    }
  | { kind: "outputsPicker"; index: number }
  | { kind: "claudeSessionsPicker"; slug: string; index: number }
  | {
      kind: "claudeSessionsNew";
      slug: string;
      input: TextEdit;
      error: string | null;
    }
  | { kind: "harnessSelect"; slug: string; index: number }
  | { kind: "killActionConfirm"; slug: string; actionName: string }
  | {
      /**
       * Session kill confirm for the shell/diff sessions (opened by
       * Shift+F10/F11). Harness sessions kill DIRECTLY from the
       * sessions picker's `x` — reaching that row already took two
       * deliberate steps, so no confirm gate there.
       */
      kind: "killSessionConfirm";
      slug: string;
      sessionKind: "shell" | "diff";
    };
