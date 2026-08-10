/**
 * Browser-tab ownership: which browser tabs belong to which worktree,
 * so destroying a worktree can take its tabs with it.
 *
 * Agents drive the user's real browser through `browser-control`, whose
 * unit of ownership is a named *session* that owns the pages it opened.
 * That's the whole association mechanism — wt doesn't track tabs, doesn't
 * watch the browser, and never talks to it during normal operation. It
 * only:
 *
 *  1. names the session for each worktree (`BROWSER_CONTROL_SESSION` in
 *     every harness session's environment, see `tmux/inner-process.ts`),
 *     so an agent that browses inherits the right name without being
 *     told what it is, and
 *  2. deletes that session on destroy, which closes the pages it opened.
 *
 * The `wt-` prefix is the safety boundary: wt only ever deletes sessions
 * it named, never one an agent or the user made up. And `session delete`
 * *releases* a tab the user attached by hand rather than closing it — so
 * the worst case is a tab wt opened outliving its worktree, never one of
 * the user's own tabs disappearing.
 *
 * Every failure here is swallowed. A browser tab is not worth failing a
 * teardown over, and the common "failures" are ordinary: browser-control
 * isn't installed, the relay isn't running, the agent never browsed.
 */
import { createLogger } from "./logger.ts";
import { run } from "./proc.ts";

const log = createLogger("[browser]");

const BIN = "browser-control";

/** Namespace for wt-owned browser sessions. See the delete guard below. */
const PREFIX = "wt-";

/**
 * The browser session name a worktree's agents browse under. Exported
 * for the session-environment plumbing; agents read it from
 * `$BROWSER_CONTROL_SESSION` rather than reconstructing it.
 */
export function browserSessionName(slug: string): string {
  return `${PREFIX}${slug}`;
}

/**
 * Whether `sessionId` is a browser session wt named for `slug` — the
 * slug's own session, or a `wt-<slug>-<suffix>` an agent made for a
 * second browser context. This is the guard that keeps cleanup from
 * reaching sessions wt didn't create, so it matches on a `-` boundary:
 * destroying `foo` must not close `wt-foobar`'s tabs.
 */
export function ownsBrowserSession(slug: string, sessionId: string): boolean {
  const own = browserSessionName(slug);
  return sessionId === own || sessionId.startsWith(`${own}-`);
}

type StatusJson = {
  relay?: { running?: boolean };
  extension?: { sessions?: { id?: unknown }[] };
};

/**
 * Session ids the relay currently knows about, or `null` when we can't
 * ask (no binary, relay down, unparseable output). `status --json` is
 * the right probe precisely because it is read-only and — unlike the
 * relay-backed commands — never *starts* a relay: a destroy must not
 * spin up browser infrastructure just to discover there was nothing to
 * clean up.
 */
async function liveSessionIds(): Promise<string[] | null> {
  if (!Bun.which(BIN)) return null;
  const res = await run([BIN, "status", "--json"], { timeoutMs: 5000 });
  if (res.exitCode !== 0) return null;
  let parsed: StatusJson;
  try {
    parsed = JSON.parse(res.stdout) as StatusJson;
  } catch {
    return null;
  }
  if (parsed.relay?.running !== true) return null;
  const sessions = parsed.extension?.sessions ?? [];
  return sessions.map((s) => s.id).filter((id): id is string => typeof id === "string");
}

/**
 * Close the browser tabs a worktree's agents opened, by deleting the
 * browser sessions wt named for it. Matches the slug's own session plus
 * any `wt-<slug>-<suffix>` an agent made for a second browser context.
 *
 * Returns the session ids actually deleted, so the caller can report
 * real work and stay silent otherwise — no news is the common case.
 */
export async function closeWorktreeBrowserSessions(slug: string): Promise<string[]> {
  try {
    const ids = await liveSessionIds();
    if (ids === null) return [];
    const mine = ids.filter((id) => ownsBrowserSession(slug, id));
    const closed: string[] = [];
    for (const id of mine) {
      const res = await run([BIN, "session", "delete", id], { timeoutMs: 10_000 });
      if (res.exitCode === 0) closed.push(id);
      else log.debug("browser session delete failed", { id, stderr: res.stderr.trim() });
    }
    if (closed.length > 0) log.info("closed browser sessions", { slug, closed });
    return closed;
  } catch (err) {
    log.debug("browser cleanup skipped", {
      slug,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
