import type { DerivedState } from "../../core/harness/status.ts";
import type { HarnessId } from "../../core/harness/index.ts";
import { actionLineFg } from "../action-line-style.ts";
import { stateColor } from "../claude-state.ts";
import { useActiveSessionsBySlug } from "../hooks/useHarnessSessions.ts";
import { usePrimaryHarness } from "../hooks/usePrimaryHarness.ts";
import { useHarnessRun, useSessionRun } from "../hooks/useSessionRun.ts";
import {
  DOTFILES_SLOT,
  MAIN_CLONE_SLOT,
  MANAGER_SLOT,
  SESSION_SLOTS,
  WT_SOURCE_SLOT,
  type SessionSlot,
} from "../sessions/slots.ts";
import { theme } from "../theme.ts";

export type FooterMode =
  | { kind: "legend" }
  | { kind: "toast"; message: string; color?: string }
  | {
      kind: "input";
      prompt: string;
      value: string;
      purpose: "new" | "new-remote" | "rename-section";
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
  height?: number;
};

/** Status color for a slot's glyph; dim when no live session. */
function slotGlyphFg(harnessId: HarnessId, state: DerivedState | null): string {
  return state ? stateColor(harnessId, state) : theme.fgDim;
}

/**
 * One special-session indicator: the slot's own glyph (colored by its
 * live-session state) with its keybinding muted beside it — the key IS
 * the label, so the four slots stay learnable without words.
 */
function SlotBadge({
  slot,
  state,
  primary,
}: {
  slot: SessionSlot;
  state: DerivedState | null;
  primary: HarnessId;
}) {
  return (
    <text wrapMode="none">
      <span fg={slotGlyphFg(primary, state)}>{slot.glyph}</span>
      <span fg={theme.fgDim}> {slot.key}</span>
    </text>
  );
}

export function Footer({ mode, hint }: Props) {
  // Every special session gets a permanent indicator: main (`.`) and
  // the manager (`m`) on the left where the main tail lives, wt-source
  // (`,`) and dotfiles (`/`) bundled at the far right. Each slot shows
  // its OWN glyph (what the session is for) — not the harness robot —
  // with its keybinding muted beside it. Colors follow the TAB-selected
  // primary harness's live session in that slot: a slot keybind always
  // opens the primary harness, so a dim glyph means "no live
  // primary-harness session here", not "no session at all".
  const primary = usePrimaryHarness();
  const slotSessions = useActiveSessionsBySlug(SESSION_SLOTS, primary, primary);
  const wtState = slotSessions.get(WT_SOURCE_SLOT.slug)?.state ?? null;
  const dotfilesState = slotSessions.get(DOTFILES_SLOT.slug)?.state ?? null;
  const managerState = slotSessions.get(MANAGER_SLOT.slug)?.state ?? null;
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
          <MainSlotTail
            state={slotSessions.get(MAIN_CLONE_SLOT.slug)?.state ?? null}
            managerState={managerState}
          />
        ) : null}
        {mode.kind === "toast" ? (
          <text fg={mode.color ?? theme.ok}>{mode.message}</text>
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
        <box marginRight={2} flexShrink={0}>
          <SlotBadge slot={WT_SOURCE_SLOT} state={wtState} primary={primary} />
        </box>
        <box flexShrink={0}>
          <SlotBadge slot={DOTFILES_SLOT} state={dotfilesState} primary={primary} />
        </box>
      </box>
    </box>
  );
}

/**
 * Left cluster of the bottom bar's default mode: the main-clone slot's
 * glyph+key, the manager's glyph+key to its right, then the latest
 * `ActionLine` from the MAIN session colored per its kind (the tail
 * belongs to `.` — the manager's conversation is entered, not tailed
 * here). When no main session is live or no lines have arrived yet
 * (pre-creation race), falls back to a dim idle hint that still
 * surfaces `?` for help. Both glyph colors and the tail TEXT follow
 * the TAB-selected primary harness: claude reads its jsonl tail,
 * codex/opencode read their `harnessTailRegistry` trail (rollout
 * jsonl / SQLite). The three tail hooks are all called unconditionally
 * (rules of hooks); we pick the primary's run. A non-primary harness
 * session in a slot lights nothing here — the slot keybind opens the
 * primary, so the bar tracks the primary.
 */
function MainSlotTail({
  state,
  managerState,
}: {
  state: DerivedState | null;
  managerState: DerivedState | null;
}) {
  const primary = usePrimaryHarness();
  const claudeRun = useSessionRun(MAIN_CLONE_SLOT.slug, null);
  const codexRun = useHarnessRun(MAIN_CLONE_SLOT.slug, "codex");
  const opencodeRun = useHarnessRun(MAIN_CLONE_SLOT.slug, "opencode");
  const run =
    primary === "claude"
      ? claudeRun
      : primary === "codex"
        ? codexRun
        : opencodeRun;
  const lastLine =
    run && run.lines.length > 0 ? run.lines[run.lines.length - 1] : null;
  const badges = (
    <>
      <box marginRight={2} flexShrink={0}>
        <SlotBadge slot={MAIN_CLONE_SLOT} state={state} primary={primary} />
      </box>
      <box marginRight={2} flexShrink={0}>
        <SlotBadge slot={MANAGER_SLOT} state={managerState} primary={primary} />
      </box>
    </>
  );
  if (!lastLine) {
    return (
      <>
        {badges}
        <text wrapMode="none" truncate>
          <span fg={theme.fgDim}>idle  ·  </span>
          <span fg={theme.accent}>?</span>
          <span fg={theme.fgDim}> help</span>
        </text>
      </>
    );
  }
  return (
    <>
      {badges}
      <text wrapMode="none" truncate>
        <span fg={actionLineFg(lastLine.kind)}>{lastLine.text}</span>
      </text>
    </>
  );
}
