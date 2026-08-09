import { useSyncExternalStore } from "react";

import type { DerivedState } from "../../core/harness/status.ts";
import type { HarnessId } from "../../core/harness/index.ts";
import {
  contextWindowTokens,
  sessionTailRegistry,
  tailKey,
} from "../../core/harness/claude/tail.ts";
import { MANAGER_CLAUDE_NAME, MANAGER_SLUG } from "../../core/manager.ts";
import { stateColor } from "../claude-state.ts";
import { useActiveSessionsBySlug } from "../hooks/useHarnessSessions.ts";
import { useManagerAskingSignal } from "../hooks/useManagerSignals.ts";
import { usePrimaryHarness } from "../hooks/usePrimaryHarness.ts";
import {
  DOTFILES_SLOT,
  MAIN_CLONE_SLOT,
  MANAGER_SLOT,
  SESSION_SLOTS,
  WT_SOURCE_SLOT,
  type SessionSlot,
} from "../sessions/slots.ts";
import { theme } from "../theme.ts";
import { useToast } from "../toast.ts";

export type FooterMode =
  | { kind: "legend" }
  | {
      kind: "input";
      prompt: string;
      value: string;
      purpose: "new" | "new-remote" | "rename-section" | "status-note";
      /**
       * Optional default `--base` ref for the new-worktree input (set
       * by the `N` keybinding). Not rendered in the prompt; the event
       * log carries the notice. An explicit `--base` in the input
       * text overrides this.
       */
      base?: string;
    };

type Props = {
  mode: FooterMode;
  hint?: string;
};

/**
 * One special-session button: `[<key>]` with the key colored by the
 * slot's live-session state (dim when none) and the brackets muted.
 * The key IS the label — press it and you're in that session.
 */
function SlotButton({
  slot,
  state,
  primary,
}: {
  slot: SessionSlot;
  state: DerivedState | null;
  primary: HarnessId;
}) {
  const keyFg = state ? stateColor(primary, state) : theme.fgDim;
  return (
    <text wrapMode="none">
      <span fg={theme.fgDim}>[</span>
      <span fg={keyFg}>{slot.key}</span>
      <span fg={theme.fgDim}>]</span>
    </text>
  );
}

/**
 * Buttons in checking order. `[m]` leads the group so the manager's
 * context-% readout can sit immediately to its left without visually
 * belonging to another slot's button.
 */
const BUTTON_SLOTS: readonly SessionSlot[] = [
  MANAGER_SLOT,
  MAIN_CLONE_SLOT,
  WT_SOURCE_SLOT,
  DOTFILES_SLOT,
];

/**
 * Manager conversation context occupancy in percent, from the session
 * tail's `lastUsage` (see `SessionContextUsage`). Null while no live
 * manager claude session is tailed or before its first assistant turn.
 * Push-based: the tail registry notifies as each turn lands, so a
 * `/compact` (palette `m` command) snaps the number on the next turn.
 */
function useManagerContextPct(): number | null {
  const runs = useSyncExternalStore(
    sessionTailRegistry.subscribe,
    sessionTailRegistry.getSnapshot,
  );
  const usage = runs.get(tailKey(MANAGER_SLUG, MANAGER_CLAUDE_NAME))?.lastUsage;
  if (!usage) return null;
  return Math.min(
    100,
    Math.round((100 * usage.tokens) / contextWindowTokens(usage.model)),
  );
}

/** warn at 70, err at 85 — Claude auto-compacts in the low 90s, so red
 *  means "compact now or it compacts itself mid-thought". */
function contextPctColor(pct: number): string {
  if (pct >= 85) return theme.err;
  if (pct >= 70) return theme.warn;
  return theme.fgDim;
}

export function Footer({ mode, hint }: Props) {
  // Every special session gets a permanent `[key]` button, grouped at
  // the far right. Key color follows the TAB-selected primary
  // harness's live session in that slot: a slot keybind always opens
  // the primary harness, so a dim key means "no live primary-harness
  // session here", not "no session at all".
  const primary = usePrimaryHarness();
  const slotSessions = useActiveSessionsBySlug(SESSION_SLOTS, primary, primary);
  const managerPct = useManagerContextPct();
  // One attention line when the manager flips to asking — its only
  // other surface is the tiny [m] color below.
  useManagerAskingSignal(slotSessions.get(MANAGER_SLOT.slug)?.state ?? null);
  // The left region belongs to transient content: the active toast
  // when there is one, else a quiet help hint. Input mode replaces it.
  const activeToast = useToast();
  return (
    <box
      flexShrink={0}
      backgroundColor={theme.bgAlt}
      paddingLeft={1}
      paddingRight={1}
      height={1}
      flexDirection="row"
    >
      <box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
        {mode.kind === "legend" ? (
          activeToast ? (
            <text wrapMode="none" truncate fg={activeToast.color}>
              {activeToast.text}
            </text>
          ) : (
            <text wrapMode="none">
              <span fg={theme.accent}>?</span>
              <span fg={theme.fgDim}> help</span>
            </text>
          )
        ) : null}
        {mode.kind === "input" ? (
          <>
            <text>
              <span fg={theme.accent} attributes={1}>
                {mode.prompt}
              </span>
              <span> </span>
              <span fg={theme.fgBright}>{mode.value}</span>
              <span fg={theme.accent}>█</span>
            </text>
            <text fg={theme.fgDim}> (⏎ submit, esc cancel)</text>
          </>
        ) : null}
      </box>
      {hint ? (
        <box flexShrink={0} flexDirection="row">
          <text fg={theme.fgDim}>{hint}</text>
        </box>
      ) : null}
      <box flexShrink={0} marginLeft={2} flexDirection="row">
        {managerPct !== null ? (
          <box flexShrink={0} marginRight={1}>
            <text wrapMode="none" fg={contextPctColor(managerPct)}>
              {`${managerPct}%`}
            </text>
          </box>
        ) : null}
        {BUTTON_SLOTS.map((slot, i) => (
          <box
            key={slot.slug}
            flexShrink={0}
            marginRight={i === BUTTON_SLOTS.length - 1 ? 0 : 2}
          >
            <SlotButton
              slot={slot}
              state={slotSessions.get(slot.slug)?.state ?? null}
              primary={primary}
            />
          </box>
        ))}
      </box>
    </box>
  );
}
