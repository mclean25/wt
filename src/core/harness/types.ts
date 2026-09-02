/**
 * AI coding harness abstraction. wt supports running multiple harnesses
 * (Claude Code, Codex, OpenCode) concurrently per worktree. Each impl
 * lives in its own file under `core/harness/` and registers via
 * `index.ts`.
 *
 * The interface is deliberately narrow — list, spawn, kill, name — so
 * adding a fourth harness is mostly mechanical. Features Claude has
 * but others don't (busy/idle registry, last-prompt summaries) are
 * NOT in the contract; the consumer renders "Unavailable" when those
 * extras are missing. The `extras` field exposes the optional Claude-
 * only data without bloating the core interface.
 */
import type { Effect } from "effect";
import type { DerivedState } from "./status.ts";

export type HarnessId = "claude" | "codex" | "opencode";

/**
 * Optional cross-harness session metadata. Harnesses fill only the
 * signals they can derive without inventing state.
 */
export type HarnessExtras = {
  /**
   * Wt-managed stable name. Null = Claude primary; Claude named sessions use
   * their native managed name. Single-slot harnesses use wt's persisted
   * `primary` / `2` / `3` mapping while their opaque session id remains the
   * authoritative resume handle.
   */
  managedName: string | null;
  /**
   * Derived state for the per-session status dot. Claude derives this
   * from jsonl tail + tmux liveness + the on-disk `~/.claude/sessions`
   * registry. Others return null and the renderer falls back to a
   * simple live/dead indicator.
   */
  derivedState: DerivedState | null;
  /** Pending-prompt count for the queued badge. Claude-only. */
  queued: number;
  /**
   * What claude is blocked on when `derivedState === "asking"` (e.g.
   * "permission prompt"), straight from the registry's `waitingFor`.
   * Null in every other state and for non-Claude harnesses.
   */
  waitingFor?: string | null;
  /**
   * Registry `updatedAt` — ms-since-epoch of the session's last status
   * write. For idle/asking/waiting/shell, CC writes once on entering the
   * state, so this is effectively when the session entered its current
   * state; for busy a slow heartbeat keeps it fresh. The claude row
   * renders `now - statusSince` as time-in-state. Claude-only and live-
   * only — null when there's no registry entry (e.g. a dead session),
   * so the row falls back to the jsonl `lastActiveMs`.
   */
  statusSince?: number | null;
  /**
   * Timestamp (ms-since-epoch) of the last message row seen, used by
   * `useHarnessSessions` to finalize `derivedState` once liveness is
   * known. OpenCode populates this; Claude / Codex leave it undefined.
   * Timestamp of the latest harness-native event/message. Kept separate
   * from `lastActiveMs` because some stores update session metadata and
   * message rows independently.
   */
  tailEndedAt?: number | null;
  /**
   * The harness's own end-of-session wrap-up line, when current (see
   * `SessionTail.sessionSummary` — no newer message may follow it).
   * Claude-only; rendered above the AI diff summary in the details
   * pane. Undefined/null elsewhere.
   */
  sessionSummary?: string | null;
};

export type HarnessSession = {
  /** Display name shown in pickers and rows. */
  displayName: string;
  /**
   * Stable handle to resume this exact session. Format is harness-
   * specific (UUID for Claude, rollout id for Codex, `ses_…` for
   * OpenCode). Pass back as `resumeSessionId` to `buildArgs`.
   */
  sessionId: string;
  /**
   * Tmux session name that would currently host this session. The
   * consumer cross-references against the live tmux name set to derive
   * `isLive` — see `useHarnessSessions`. Claude returns the legacy
   * `<slug>` / `<slug>~<name>` format; Codex / OpenCode return
   * `<slug>-codex` / `<slug>-opencode` (single tmux slot per slug per
   * harness for v1).
   */
  tmuxSessionName: string;
  /** Last meaningful activity ms-since-epoch, or null if unknown. */
  lastActiveMs: number | null;
  /** True when a tmux session is currently running this. */
  isLive: boolean;
  extras: HarnessExtras;
};

export type HarnessSpawnArgs = {
  wtPath: string;
  /**
   * Worktree slug (or slot slug) this session belongs to. Claude uses
   * it to derive the session's `--name`, which is both its `/resume`
   * label and the address other Claude instances message it by — see
   * `claudeHarness.buildArgs`.
   */
  slug: string;
  /**
   * Wt-managed name (Claude only). For others, ignored — they generate
   * their own session ids on spawn.
   */
  managedName: string | null;
  /**
   * Resume an existing session, or null to spawn fresh.
   */
  resumeSessionId: string | null;
  /**
   * Explicit display label, overriding the slug-derived default.
   * Session slots pass their label here (the manager's cwd-sharing
   * managed name would otherwise read as `manager~manager`). Claude
   * only; ignored by other harnesses.
   */
  displayLabel?: string;
};

export interface Harness {
  readonly id: HarnessId;
  readonly label: string;
  /** Sub-affordance letter in the sessions picker. */
  readonly letter: string;
  /** Nerd-Font glyph rendered next to entries. */
  readonly glyph: string;
  /** Theme color hex. */
  readonly color: string;
  /**
   * True when the harness uses a single shared tmux slot per slug
   * (`<slug>-<id>`), so resuming a specific session must displace
   * whatever's running in the slot (`freshSlot`), and only one
   * discovered session can be live at a time. False for claude, which
   * gets a unique tmux name per managed session. This is the capability
   * that used to be spelled `id === "codex" || id === "opencode"` at
   * every call site.
   */
  readonly singleSlot: boolean;
  /**
   * Prefix this harness uses to invoke named skills / slash commands in
   * a prompt. Claude Code uses `/`; OpenCode and Codex use `$`.
   * Substituted into action prompts as `{{skill_prefix}}` at launch
   * time (see `buildActionVars` in `tui/app-helpers.ts`), so a single prompt
   * like `{{skill_prefix}}restack` lands correctly regardless of which
   * harness is the row's primary. Headless prompt actions use the
   * selected primary harness's non-interactive CLI, so they use the
   * same prefix as prompts sent to a session.
   */
  readonly skillPrefix: string;
  /**
   * tmux `send-keys` key sequence submitted after a bracketed paste,
   * for messages delivered through terminal input. Every harness needs
   * one: it is the only transport for codex/opencode, and Claude's
   * fallback when its prompt can't be submitted into directly (see
   * `harness/session-messaging.ts`). Keys are sent in order with a
   * small gap between each. Override per harness when a different
   * sequence (e.g. `C-d`, `C-j`) turns out to fit better.
   */
  readonly injectSubmitKeys: readonly string[];

  /**
   * Did a programmatically delivered prompt reach the conversation at/after
   * `sinceMs`? Optional: `undefined` means this harness has no
   * transcript wt can read, so a terminal adapter reports delivery as
   * unknown rather than claiming success. Implementations answer from
   * durable state (the conversation log), never from the pane — the
   * whole point is to catch the case where the pane accepted keystrokes
   * that a modal, not the input box, consumed.
   */
  injectionLanded?(opts: {
    cwd: string;
    managedName: string | null;
    text: string;
    sinceMs: number;
  }): boolean;

  /**
   * Tmux session name for a (slug, managedName). Each impl encodes its
   * own scheme so harnesses can coexist on the same slug without
   * colliding. Claude preserves the legacy `<slug>` / `<slug>~<name>`
   * format; Codex/OpenCode use `<slug>-<id>` / `<slug>-<id>~<name>`.
   */
  tmuxSessionName(slug: string, managedName: string | null): string;

  /**
   * Discover every session this harness knows about for the given
   * worktree. Liveness is NOT decided here — the impl returns
   * `isLive: false` for every entry and `useHarnessSessions`
   * re-annotates against the current tmux name set. Decoupling
   * liveness from discovery means the discovery query can cache on
   * `(harnessId, slug)` without invalidating on every 2s tmux poll.
   *
   * Known gap: a session that is live in tmux but absent from the
   * impl's on-disk store (e.g. a hypothetical hand-renamed tmux
   * session, or a spawn whose persistence write failed) won't appear
   * in the picker. The spawn flows persist before attaching, so this
   * is unreachable in practice; flagging here for the future.
   */
  discoverSessions(opts: {
    slug: string;
    wtPath: string;
    /** Cancel superseded UI discovery before it can build queued work. */
    signal?: AbortSignal;
  }): Promise<HarnessSession[]>;

  /** Inner argv to launch (or resume) a session. Spliced into tmux new-session. */
  buildArgs(args: HarnessSpawnArgs): string[];

  /**
   * Optional: make `wtPath` trusted for this harness before a session is
   * spawned there, so its one-time "trust this folder?" gate doesn't fire.
   * Called at every spawn site right before `buildArgs`; must be
   * idempotent and best-effort. Only harnesses whose trust is keyed by an
   * independent path need it — Claude does, for rift worktrees (each is an
   * independent clone Claude treats as a new project); omit for harnesses
   * that inherit trust from the main repo or have no such gate. Returns an
   * Effect so a retrying implementation waits on the fiber, never the thread.
   */
  ensureTrusted?(wtPath: string): Effect.Effect<void>;

  /**
   * Reap on-disk state for slugs no longer present. Called at startup.
   * No-op when impl has no on-disk state of its own.
   */
  reapState(liveSlugs: ReadonlySet<string>): void;
}
