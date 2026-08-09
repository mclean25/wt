import { join } from "node:path";

import { getHarness, type HarnessId } from "../harness/index.ts";
import { withAsyncFileLock } from "../locks.ts";
import { createLogger } from "../logger.ts";
import { buildInnerArgs, sessionsDir, tmuxClientCwd } from "./attach.ts";
import { ensureConfig } from "./config.ts";
import { wrapInnerArgs } from "./inner-process.ts";
import { sessionName, TMUX_SOCKET } from "./naming.ts";
import { capturePane, listAllSessionsRaw, paneTarget, runTmux } from "./process.ts";

const log = createLogger("[tmux]");

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
/** Gap between successive submit keys (e.g. claude's double Enter). */
const SUBMIT_KEY_GAP_MS = 250;
/** Re-paste attempts when the pane shows no trace of the paste. */
const PASTE_MAX_RETRIES = 3;
/** Extra grace before a re-paste attempt. */
const PASTE_RETRY_GRACE_MS = 1_000;

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
async function waitForPaneReady(name: string): Promise<boolean> {
  const deadline = Date.now() + READY_MAX_MS;
  let prev: string | null = null;
  // Initial grace — harnesses often write nothing for the first beat after spawn.
  await sleep(READY_POLL_MS);
  while (Date.now() < deadline) {
    const cur = (await capturePane(name))?.trim() ?? "";
    if (cur.length > 0 && cur === prev) return true;
    prev = cur;
    await sleep(READY_POLL_MS);
  }
  return false;
}

/**
 * Create the worktree's primary harness session detached (no client
 * attach). Byte-for-byte the session `attachOrCreate({kind:harnessId})`
 * would make — same name, same `buildArgs` argv (via the shared
 * `buildInnerArgs`/`wrapInnerArgs` helpers in attach.ts), same stderr
 * wrapper and TMUX-stripping env — so a later F12 `new-session -A` just
 * attaches to this one rather than spawning a second. Sized generously
 * so the harness doesn't render cramped before the user attaches; tmux
 * resizes to the client on attach.
 */
async function startHarnessSessionDetached(
  slug: string,
  cwd: string,
  harnessId: HarnessId,
  managedName: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const harness = getHarness(harnessId);
  const name = sessionName(slug, harnessId, managedName);
  // ensureConfig, NOT writeConfig: this can run from inside the wt tmux
  // server (e.g. `wt claude send` issued by another claude session),
  // where the rendered config differs and the kill-server-on-change
  // dance would take down every live session including the caller's.
  const configPath = ensureConfig();
  const stderrPath = join(sessionsDir(), `${name}.err`);
  // buildInnerArgs also calls harness.ensureTrusted?.(cwd) — rift
  // checkouts otherwise trip Claude's per-project trust prompt.
  const innerArgs = buildInnerArgs({
    cwd,
    kind: harnessId,
    harness,
    managedNameNorm: managedName,
    resumeSessionId: null,
  });
  let proc: Bun.Subprocess;
  try {
    proc = Bun.spawn(
      [
        "tmux",
        "-L",
        TMUX_SOCKET,
        "-f",
        configPath,
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        cwd,
        "-x",
        "200",
        "-y",
        "50",
        // See attachOrCreate header: claude downgrades to 256-color when
        // $TMUX is set, so strip it before exec'ing. The bash wrapper
        // redirects stderr to a file so a spawn-and-die surfaces a reason.
        ...wrapInnerArgs(harnessId, stderrPath, innerArgs),
      ],
      {
        // NOT the worktree — the pane cwd comes from `-c`; the client
        // cwd only matters as the server's birth cwd (see tmuxClientCwd).
        cwd: tmuxClientCwd(),
        stdout: "ignore",
        stderr: "pipe",
        env: {
          ...process.env,
          TERM: process.env.TERM ?? "xterm-256color",
          COLORTERM: process.env.COLORTERM ?? "truecolor",
          FORCE_COLOR: process.env.FORCE_COLOR ?? "3",
        },
      },
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log.error("detached harness start spawn failed", {
      slug,
      harnessId,
      reason,
    });
    return { ok: false, reason };
  }
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
  ]);
  if (code !== 0) {
    // No client attached means no `-A` (it needs a tty), so a plain
    // `new-session -d` loses the create race against a concurrent
    // `attachOrCreate` (the user pressing F12 as an automation fires)
    // with "duplicate session". A live session is exactly what the
    // caller needs for the paste — recheck reality before failing, or
    // the injected message silently drops.
    const nowExists = (await listAllSessionsRaw().catch(() => new Set<string>())).has(name);
    if (nowExists) {
      log.warn("detached harness start lost create race; session exists, proceeding", {
        slug,
        harnessId,
        code,
      });
      return { ok: true };
    }
    const reason = stderr.trim() || `tmux new-session exited ${code}`;
    log.warn("detached harness start failed", {
      slug,
      harnessId,
      code,
      reason,
    });
    return { ok: false, reason };
  }
  return { ok: true };
}

/** Pipe text into the inject buffer and paste it into a session's pane. */
async function pasteBuffer(name: string, text: string): Promise<void> {
  // A UNIQUE buffer name per call: `load-buffer` and `paste-buffer` hand off
  // by buffer name, so a fixed name races when two injects overlap (two
  // automations firing, or an automation + a manual `!` action) — the
  // second `load-buffer` overwrites before the first `paste-buffer` reads,
  // and a session gets the other's message. pid + monotonic seq is unique
  // within this process and across processes; `-d` below drops it after.
  const buffer = `${INJECT_BUFFER}-${process.pid}-${++injectSeq}`;
  // load-buffer reads stdin, so arbitrary text (quotes, `$`, newlines)
  // needs no shell escaping.
  const load = Bun.spawn(
    ["tmux", "-L", TMUX_SOCKET, "load-buffer", "-b", buffer, "-"],
    {
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  // Exit code deliberately unchecked (audited, accepted): a failed load
  // (e.g. the server died between the liveness check and here) means
  // the following paste/Enter lands on an empty buffer — visible in the
  // pane and recoverable — whereas failing the whole inject on a
  // transient tmux hiccup is worse. Revisit if a silent empty submit
  // ever actually bites.
  await load.exited;
  // `-p` = bracketed paste (claude receives it as one chunk, so internal
  // newlines and a leading slash command don't submit early); `-d` drops
  // the buffer after.
  await runTmux([
    "paste-buffer",
    "-d",
    "-p",
    "-b",
    buffer,
    "-t",
    paneTarget(name),
  ]);
}

/**
 * Send `text` to a worktree's primary (F12) harness session as if typed
 * at the prompt, then submit it. Starts the session first if it isn't
 * running, waiting for it to finish booting before pasting. The prompt
 * lands in the live conversation — with its existing context and history
 * — rather than a fresh headless action run.
 *
 * Fire-and-forget by nature: there's no completion sentinel, so callers
 * can't observe when the harness finishes.
 *
 * Known edge: a brand-new worktree directory the harness has never run in may
 * show its trust prompt on cold start; the paste+Enter would answer that
 * dialog instead of submitting. Attaching via F12 once (to accept trust)
 * before injecting avoids it.
 */
export async function injectIntoSession(opts: {
  slug: string;
  cwd: string;
  harnessId?: HarnessId;
  /** Claude-only named-session identity (the manager); null = primary. */
  managedName?: string | null;
  text: string;
}): Promise<{ ok: true; coldStarted: boolean } | { ok: false; reason: string }> {
  // Cross-process serialization per target session. Historically every
  // inject target was single-writer, but the manager slot is a genuine
  // multi-writer singleton (TUI automations, `wt manager send` from N
  // worktree agents, [[actions]] target="manager") — without this,
  // near-simultaneous injections interleave paste text and stray
  // Enters in one pane, and two cold starts race. Worktree targets get
  // the same guard for free (`wt claude send` vs the TUI's automations).
  return withAsyncFileLock(
    `__inject__${sessionName(opts.slug, opts.harnessId ?? "claude", opts.managedName ?? null)}`,
    () => injectIntoSessionUnlocked(opts),
  );
}

async function injectIntoSessionUnlocked(opts: {
  slug: string;
  cwd: string;
  harnessId?: HarnessId;
  managedName?: string | null;
  text: string;
}): Promise<{ ok: true; coldStarted: boolean } | { ok: false; reason: string }> {
  const { slug, cwd, text } = opts;
  const harnessId = opts.harnessId ?? "claude";
  const managedName = opts.managedName ?? null;
  const name = sessionName(slug, harnessId, managedName);
  const running = (
    await listAllSessionsRaw().catch(() => new Set<string>())
  ).has(name);
  let coldStarted = false;
  if (!running) {
    const started = await startHarnessSessionDetached(slug, cwd, harnessId, managedName);
    if (!started.ok) {
      return {
        ok: false,
        reason: started.reason ?? `failed to start ${harnessId} session`,
      };
    }
    coldStarted = true;
    await waitForPaneReady(name);
  } else {
    await sleep(WARM_SETTLE_MS);
  }
  try {
    // Paste, then VERIFY the pane actually changed. Claude's REPL can
    // sit visually stable — banner rendered, prompt drawn — while its
    // input is not yet accepting paste (the MCP-connect window on a
    // cold start), and a paste sent into that window is dropped
    // wholesale with no error from tmux: waitForPaneReady can't tell
    // "settled and ready" from "settled and deaf". An accepted paste
    // always changes the pane text (inline, or Claude's "[Pasted text
    // …]" placeholder), so an unchanged pane means the paste vanished —
    // wait out another settle round and re-paste, bounded. The final
    // attempt proceeds to submit regardless (pre-verify behavior).
    for (let attempt = 0; ; attempt++) {
      const before = (await capturePane(name))?.trim() ?? "";
      await pasteBuffer(name, text);
      await sleep(SUBMIT_DELAY_MS);
      const after = (await capturePane(name))?.trim() ?? "";
      if (after !== before || attempt >= PASTE_MAX_RETRIES) break;
      log.warn("inject paste left no trace in pane; re-pasting", { name, attempt });
      await sleep(PASTE_RETRY_GRACE_MS);
      await waitForPaneReady(name);
    }
    // Harnesses declare their own submit-key sequence: most take a
    // single Enter, but Claude Code and Codex receive the bracketed
    // paste as a multi-line input blob whose first Enter only exits
    // that state, so they need a second to actually submit. Keys are
    // sent in order with a small gap so the harness processes each
    // before the next lands.
    const submitKeys = getHarness(harnessId).injectSubmitKeys;
    for (let i = 0; i < submitKeys.length; i++) {
      if (i > 0) await sleep(SUBMIT_KEY_GAP_MS);
      const { code, stderr } = await runTmux([
        "send-keys",
        "-t",
        paneTarget(name),
        submitKeys[i]!,
      ]);
      if (code !== 0) {
        return {
          ok: false,
          reason: stderr.trim() || `tmux send-keys exited ${code}`,
        };
      }
    }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return { ok: true, coldStarted };
}
