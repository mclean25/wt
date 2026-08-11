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
 * Two ownership rules decide what wt may close, and BOTH are things wt
 * itself handed out: the `wt-` session name it set, and the dev PORT it
 * allocated. The port rule exists because the sessions actually sitting
 * on a worktree's app are usually named by a login or setup script, not
 * by wt, so name-matching alone sees none of them — but a tab on
 * `localhost:<the port wt assigned this worktree>` cannot belong to
 * anything else. wt never closes a session on a guess about its name.
 * And `session delete` *releases* a tab the user attached by hand
 * rather than closing it — so the worst case is a tab wt opened
 * outliving its worktree, never one of the user's own tabs
 * disappearing.
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

/**
 * Whether a session is parked on `port` of the loopback host — the
 * SECOND ownership rule, and the one that doesn't depend on who named
 * the session. wt allocates each worktree a stable dev port and pins
 * the server to it, so a tab on `localhost:<that port>` is that
 * worktree's dev server by construction, whoever opened it. That
 * matters because the sessions actually sitting on those ports are
 * routinely named by login/setup scripts (`czlogin8105`), never by wt,
 * so the `wt-` prefix rule can't see them at all.
 */
export function sessionOnDevPort(pageUrl: string | null, port: number): boolean {
  if (!pageUrl) return false;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return false;
  return url.port === String(port);
}

export type BrowserSession = { id: string; pageUrl: string | null };

type StatusJson = {
  relay?: { running?: boolean };
  extension?: { sessions?: { id?: unknown; pageUrl?: unknown }[] };
};

/**
 * Sessions the relay currently knows about, or `null` when we can't
 * ask (no binary, relay down, unparseable output). `status --json` is
 * the right probe precisely because it is read-only and — unlike the
 * relay-backed commands — never *starts* a relay: a destroy must not
 * spin up browser infrastructure just to discover there was nothing to
 * clean up.
 */
async function liveSessions(): Promise<BrowserSession[] | null> {
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
  return sessions
    .filter((s): s is { id: string; pageUrl?: unknown } => typeof s.id === "string")
    .map((s) => ({
      id: s.id,
      pageUrl: typeof s.pageUrl === "string" ? s.pageUrl : null,
    }));
}

/** Delete the given sessions, returning the ids that actually went. */
async function deleteSessions(ids: readonly string[]): Promise<string[]> {
  const closed: string[] = [];
  for (const id of ids) {
    const res = await run([BIN, "session", "delete", id], { timeoutMs: 10_000 });
    if (res.exitCode === 0) closed.push(id);
    else log.debug("browser session delete failed", { id, stderr: res.stderr.trim() });
  }
  return closed;
}

/**
 * Close the browser tabs belonging to a worktree that is going away:
 * the sessions wt named for it, plus anything parked on its dev port
 * (see `sessionOnDevPort` — the login-script sessions are the ones
 * actually holding the app open, and they carry nobody's prefix).
 *
 * Returns the session ids actually deleted, so the caller can report
 * real work and stay silent otherwise — no news is the common case.
 */
export async function closeWorktreeBrowserSessions(
  slug: string,
  devPort?: number | null,
): Promise<string[]> {
  return closeBrowserSessions(
    slug,
    (s) =>
      ownsBrowserSession(slug, s.id) ||
      (devPort != null && sessionOnDevPort(s.pageUrl, devPort)),
  );
}

/**
 * Close the tabs a worktree's dev server was serving, by dev port only.
 * Stopping the server strands them on a refused port, so they're dead
 * weight the moment it goes down — and unlike destroy, this must NOT
 * touch the worktree's other sessions: an agent's reference tabs, a PR
 * page, anything it opened that has nothing to do with the server.
 */
export async function closeDevServerBrowserSessions(
  slug: string,
  devPort: number,
): Promise<string[]> {
  return closeBrowserSessions(slug, (s) => sessionOnDevPort(s.pageUrl, devPort));
}

async function closeBrowserSessions(
  slug: string,
  owned: (session: BrowserSession) => boolean,
): Promise<string[]> {
  try {
    const sessions = await liveSessions();
    if (sessions === null) return [];
    const closed = await deleteSessions(sessions.filter(owned).map((s) => s.id));
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
