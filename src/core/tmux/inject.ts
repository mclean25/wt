import { homedir } from "node:os";
import { Clock, Duration, Effect } from "effect";

import { getHarness, type HarnessId } from "../harness/index.ts";
import { withAsyncFileLockEffect } from "../locks.ts";
import { createLogger } from "../logger.ts";
import { pollUntilEffect } from "../poll.ts";
import { runEffect } from "../proc.ts";
import { startHarnessSessionDetachedEffect } from "./lifecycle.ts";
import { sessionName, TMUX_SOCKET } from "./naming.ts";
import { capturePaneEffect, listAllSessionsRawEffect, paneTarget, runTmuxEffect } from "./process.ts";

type TerminalHarnessId = Exclude<HarnessId, "claude">;

const log = createLogger("[tmux]");

/** Prefix for the per-call tmux paste buffer used by `injectIntoSession`. */
const INJECT_BUFFER = "wt-inject";
/** Disambiguates concurrent injects sharing this process's pid. */
let injectSeq = 0;
/** Settle pause when the session is already running before pasting. */
const WARM_SETTLE_MS = 300;
/** capture-pane poll interval while waiting for a cold start to render. */
const READY_POLL_MS = 350;
/** Hard cap on the cold-start readiness wait; inject anyway after this. */
const READY_MAX_MS = 12_000;
/** Gap between the paste landing and the Enter that submits it. */
const SUBMIT_DELAY_MS = 500;
/** Gap between successive submit keys. */
const SUBMIT_KEY_GAP_MS = 250;
/** Re-paste attempts when the pane shows no trace of the paste. */
const PASTE_MAX_RETRIES = 3;
/** Extra grace before a re-paste attempt. */
const PASTE_RETRY_GRACE_MS = 1_000;
/**
 * Total elapsed budget for the verify/retry loop. The inject holds a
 * cross-process per-session lock (multi-writer manager slot), and each
 * retry can burn a grace + a full settle wait — unbounded, a few slow
 * verifies queued on one session would push later writers past the
 * lock's acquisition timeout and DROP their messages. Past the budget
 * the current paste proceeds to submit as-is.
 */
const PASTE_VERIFY_BUDGET_MS = 20_000;
/**
 * How long to wait for the submitted prompt to show up in the harness's
 * own transcript. Sized for the harness to write the user entry, not for the
 * turn to finish: the entry is written as the input is accepted, so this
 * only has to cover process scheduling and the fs flush.
 */
const DELIVERY_CONFIRM_MS = 8_000;
/** Poll interval while confirming delivery. */
const DELIVERY_POLL_MS = 250;

export type InjectResult =
  | {
      ok: true;
      /** The session wasn't running and was started for this message. */
      coldStarted: boolean;
      /**
       * Did the prompt reach the conversation? `null` = the harness
       * exposes no transcript to check against, so delivery is unknown —
       * report it that way, never as success.
       */
      delivered: boolean | null;
      /** A first attempt was swallowed and the prompt was sent again. */
      resent: boolean;
    }
  | { ok: false; reason: string };

/**
 * Wait until a freshly-started harness pane stops changing — meaning it
 * has finished its initial render and is sitting at an idle prompt — or
 * the cap elapses. Stability (two identical, non-trivial snapshots) is
 * version-agnostic: we never scrape the harness's exact prompt string, we
 * just watch for the screen to settle. A startup spinner keeps the pane
 * changing, so the loop naturally waits out a slow boot instead of
 * guessing a fixed delay. Returns whether it settled (false = hit the
 * cap; the caller pastes anyway).
 */
function waitForPaneReadyEffect(name: string): Effect.Effect<boolean> {
  return Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + READY_MAX_MS;
    let prev: string | null = null;
    // Initial grace — harnesses often write nothing for the first beat after spawn.
    yield* Effect.sleep(Duration.millis(READY_POLL_MS));
    while ((yield* Clock.currentTimeMillis) < deadline) {
      const cur = (yield* capturePaneEffect(name))?.trim() ?? "";
      if (cur.length > 0 && cur === prev) return true;
      prev = cur;
      yield* Effect.sleep(Duration.millis(READY_POLL_MS));
    }
    return false;
  });
}

/** Pipe text into the inject buffer and paste it into a session's pane. */
function pasteBufferEffect(name: string, text: string): Effect.Effect<void> {
  // A UNIQUE buffer name per call: `load-buffer` and `paste-buffer` hand off
  // by buffer name, so a fixed name races when two injects overlap (two
  // automations firing, or an automation + a manual `!` action) — the
  // second `load-buffer` overwrites before the first `paste-buffer` reads,
  // and a session gets the other's message. pid + monotonic seq is unique
  // within this process and across processes; `-d` below drops it after.
  const buffer = `${INJECT_BUFFER}-${process.pid}-${++injectSeq}`;
  // load-buffer reads stdin, so arbitrary text (quotes, `$`, newlines)
  // needs no shell escaping.
  return Effect.gen(function* () {
    // Exit code deliberately unchecked (audited, accepted): a failed load
    // means the following paste/Enter lands on an empty buffer, preserving
    // the historical best-effort fallback contract.
    yield* runEffect(
      ["tmux", "-L", TMUX_SOCKET, "load-buffer", "-b", buffer, "-"],
      { cwd: homedir(), input: text },
    ).pipe(Effect.ignore);
    // `-p` = bracketed paste, so internal newlines do not submit early;
    // `-d` drops the buffer after.
    yield* runTmuxEffect([
      "paste-buffer",
      "-d",
      "-p",
      "-b",
      buffer,
      "-t",
      paneTarget(name),
    ]);
  });
}

/**
 * Send `text` to a worktree's primary (F12) harness session as if typed
 * at the prompt, then submit it. Starts the session first if it isn't
 * running, waiting for it to finish booting before pasting. The prompt
 * lands in the live conversation — with its existing context and history
 * — rather than a fresh headless action run.
 *
 * This is the FALLBACK transport, not the preferred one. Claude
 * sessions are normally reached by submitting at their prompt
 * in-process (`harness/claude/inject.ts`), which preserves a draft and
 * cannot be mistaken for a keystroke; typing is what's left when that
 * is unavailable. `sendSessionMessage` owns the choice — don't call
 * this directly for claude.
 *
 * Fire-and-forget as to the RESULT — there's no completion sentinel, so
 * callers can't observe when the harness finishes — but no longer as to
 * the delivery: `delivered` reports whether the prompt actually entered
 * the conversation (`null` when the harness offers no way to tell). A
 * cold start that swallowed the prompt is re-sent once automatically.
 * Callers must not print an unqualified success line on
 * `delivered === false`; a lost fan-out that reports success is how a
 * fleet-wide nudge evaporates in silence.
 *
 * Known edge: a brand-new worktree directory the harness has never run in may
 * show its trust prompt on cold start; the paste+Enter would answer that
 * dialog instead of submitting. Attaching via F12 once (to accept trust)
 * before injecting avoids it.
 */
export function injectIntoSessionEffect(opts: {
  slug: string;
  cwd: string;
  harnessId: TerminalHarnessId;
  managedName?: string | null;
  text: string;
}): Effect.Effect<InjectResult> {
  // Type-level AND runtime, as before this became Claude's fallback:
  // typing into a live Claude pane clobbers a draft and can answer a
  // dialog, so reaching it must be a deliberate act. `injectIntoSession`
  // is re-exported from the `core/tmux.ts` barrel, where a prose comment
  // is not a guard.
  if ((opts.harnessId as HarnessId) === "claude") {
    return Effect.succeed({
      ok: false,
      reason: "Claude is not typed at by default; route through sendSessionMessage",
    });
  }
  return lockedInject(opts);
}

/** Promise boundary for message transports that still expose callbacks. */
export function injectIntoSession(
  opts: Parameters<typeof injectIntoSessionEffect>[0],
): Promise<InjectResult> {
  return Effect.runPromise(injectIntoSessionEffect(opts));
}

/**
 * The one sanctioned way to type into a Claude session's pane.
 *
 * Claude is normally reached by submitting at its prompt in-process
 * (`harness/claude/inject.ts`), which preserves a draft and cannot be
 * mistaken for a keystroke. This exists for when that is unavailable —
 * a session wt didn't start, or one whose socket died with a restart —
 * and `sendSessionMessage` is its only legitimate caller, because only
 * that function knows the two states in which typing is NOT safe (the
 * session is waiting on a human; a submit is already in flight).
 *
 * Named separately rather than relaxing `injectIntoSession`'s type so
 * that reaching it stays a deliberate act with a place to explain
 * itself.
 */
export function injectClaudeFallbackEffect(opts: {
  slug: string;
  cwd: string;
  managedName?: string | null;
  text: string;
}): Effect.Effect<InjectResult> {
  return lockedInject({ ...opts, harnessId: "claude" });
}

/** Promise boundary for the harness transport interface. */
export function injectClaudeFallback(
  opts: Parameters<typeof injectClaudeFallbackEffect>[0],
): Promise<InjectResult> {
  return Effect.runPromise(injectClaudeFallbackEffect(opts));
}

function lockedInject(opts: {
  slug: string;
  cwd: string;
  harnessId: HarnessId;
  managedName?: string | null;
  text: string;
}): Effect.Effect<InjectResult> {
  // Cross-process serialization per target session. Historically every
  // terminal-message target was single-writer, but the manager slot is a genuine
  // multi-writer singleton (TUI automations, `wt manager send` from N
  // worktree agents, [[actions]] target="manager") — without this,
  // near-simultaneous injections interleave paste text and stray
  // Enters in one pane, and two cold starts race. Worktree targets get
  // the same guard for free.
  return withAsyncFileLockEffect(
    `__inject__${sessionName(opts.slug, opts.harnessId, opts.managedName ?? null)}`,
    injectIntoSessionUnlockedEffect(opts),
  ).pipe(
    Effect.catchAll((cause) =>
      Effect.succeed({
        ok: false as const,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
    ),
  );
}

function injectIntoSessionUnlockedEffect(opts: {
  slug: string;
  cwd: string;
  harnessId: HarnessId;
  managedName?: string | null;
  text: string;
}): Effect.Effect<InjectResult> {
  return Effect.gen(function* () {
    const { slug, cwd, text } = opts;
    const harnessId = opts.harnessId;
    const managedName = opts.managedName ?? null;
    const name = sessionName(slug, harnessId, managedName);
    const running = (yield* listAllSessionsRawEffect()).has(name);
    let coldStarted = false;
    if (!running) {
      const started = yield* startHarnessSessionDetachedEffect(
        slug,
        cwd,
        harnessId,
        managedName,
      );
      if (!started.ok) {
        return {
          ok: false as const,
          reason: started.reason ?? `failed to start ${harnessId} session`,
        };
      }
      coldStarted = true;
      yield* waitForPaneReadyEffect(name);
    } else {
      yield* Effect.sleep(Duration.millis(WARM_SETTLE_MS));
    }
    // Stamped before the paste: the transcript entry we're looking for
    // can't predate the keystrokes that produced it.
    const sinceMs = yield* Clock.currentTimeMillis;
    const submitted = yield* pasteAndSubmitEffect(name, harnessId, text);
    if (!submitted.ok) return submitted;

    // The pane accepted the keystrokes — that is NOT the same as the
    // conversation accepting the prompt. Ask the harness transcript too.
    let delivered = yield* confirmDeliveryEffect({
      slug,
      cwd,
      harnessId,
      managedName,
      text,
      sinceMs,
    });
    let resent = false;
    if (delivered === false && coldStarted) {
      log.warn("injected prompt never reached the conversation; re-sending", { name });
      yield* waitForPaneReadyEffect(name);
      const retrySince = yield* Clock.currentTimeMillis;
      const again = yield* pasteAndSubmitEffect(name, harnessId, text);
      if (!again.ok) return again;
      resent = true;
      delivered = yield* confirmDeliveryEffect({
        slug,
        cwd,
        harnessId,
        managedName,
        text,
        sinceMs: retrySince,
      });
    }
    return { ok: true as const, coldStarted, delivered, resent };
  });
}

/**
 * Poll the harness's transcript until the injected prompt shows up.
 * `null` = this harness can't tell (no `injectionLanded`), which callers
 * must report as unknown rather than as success.
 */
function confirmDeliveryEffect(opts: {
  slug: string;
  cwd: string;
  harnessId: HarnessId;
  managedName: string | null;
  text: string;
  sinceMs: number;
}): Effect.Effect<boolean | null> {
  const { cwd, harnessId, managedName, text, sinceMs } = opts;
  const harness = getHarness(harnessId);
  if (!harness.injectionLanded) return Effect.succeed(null);
  return pollUntilEffect({
    check: () => harness.injectionLanded!({ cwd, managedName, text, sinceMs }),
    budgetMs: DELIVERY_CONFIRM_MS,
    intervalMs: DELIVERY_POLL_MS,
  }).pipe(
    Effect.catchAll((cause) =>
      Effect.sync(() => {
        // A check that THREW can't answer the question — that's unknown,
        // not "did not arrive", and the caller must report it as such.
        log.warn("delivery check failed", {
          slug: opts.slug,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
        return null;
      }),
    ),
  );
}

/** Paste `text` into a ready pane and press the harness's submit keys. */
function pasteAndSubmitEffect(
  name: string,
  harnessId: HarnessId,
  text: string,
): Effect.Effect<{ ok: true } | { ok: false; reason: string }> {
  return Effect.gen(function* () {
    // Paste, then verify the pane actually changed. A harness can
    // sit visually stable — banner rendered, prompt drawn — while its
    // input is not yet accepting paste (the MCP-connect window on a
    // cold start), and a paste sent into that window is dropped
    // wholesale with no error from tmux: waitForPaneReady can't tell
    // "settled and ready" from "settled and deaf". An accepted paste
    // always changes the pane text, so a pane still identical to the PRE-paste
    // snapshot means the paste vanished — wait out another settle round
    // and re-paste, bounded by attempts AND elapsed time (the lock-hold
    // note on PASTE_VERIFY_BUDGET_MS). Every comparison is against the
    // original pre-paste snapshot, and each retry re-checks it first —
    // a first paste that merely RENDERED slowly is detected as landed
    // and never double-pasted. Accepted residual (audited): on a warm
    // pane that happens to be streaming unrelated output, ambient churn
    // can mask a genuinely dropped paste (no retry — the pre-verify
    // behavior); observed drops are cold-start-only, where the pane is
    // static and the comparison is clean. The final attempt proceeds to
    // submit regardless.
    const prePaste = (yield* capturePaneEffect(name))?.trim() ?? "";
    const verifyDeadline = (yield* Clock.currentTimeMillis) + PASTE_VERIFY_BUDGET_MS;
    yield* pasteBufferEffect(name, text);
    yield* Effect.sleep(Duration.millis(SUBMIT_DELAY_MS));
    for (let attempt = 0; attempt < PASTE_MAX_RETRIES; attempt++) {
      let now = (yield* capturePaneEffect(name))?.trim() ?? "";
      if (now !== prePaste || (yield* Clock.currentTimeMillis) >= verifyDeadline) break;
      log.warn("inject paste left no trace in pane; waiting, then re-pasting", { name, attempt });
      yield* Effect.sleep(Duration.millis(PASTE_RETRY_GRACE_MS));
      yield* waitForPaneReadyEffect(name);
      // Late landing? The earlier paste may have rendered during the
      // grace/settle — re-pasting on top would submit the text twice.
      now = (yield* capturePaneEffect(name))?.trim() ?? "";
      if (now !== prePaste) break;
      yield* pasteBufferEffect(name, text);
      yield* Effect.sleep(Duration.millis(SUBMIT_DELAY_MS));
    }
    // Harnesses declare their own submit-key sequence: most take a
    // single Enter, while some receive a bracketed multi-line paste as
    // an input blob that needs another key to submit. Keys are
    // sent in order with a small gap so the harness processes each
    // before the next lands.
    const submitKeys = getHarness(harnessId).injectSubmitKeys;
    for (let i = 0; i < submitKeys.length; i++) {
      if (i > 0) yield* Effect.sleep(Duration.millis(SUBMIT_KEY_GAP_MS));
      const { code, stderr } = yield* runTmuxEffect([
        "send-keys",
        "-t",
        paneTarget(name),
        submitKeys[i]!,
      ]);
      if (code !== 0) {
        return {
          ok: false as const,
          reason: stderr.trim() || `tmux send-keys exited ${code}`,
        };
      }
    }
    return { ok: true as const };
  });
}
