/**
 * Browser-tab ownership: which browser tabs belong to which worktree,
 * so destroying a worktree can take its tabs with it.
 *
 * Cleanup runs on TWO independent mechanisms, because neither one alone
 * actually closes the tab:
 *
 *  1. **`browser-control` sessions.** Agents drive the user's real
 *     browser through `browser-control`, whose unit of ownership is a
 *     named *session* owning the pages it opened. wt names that session
 *     for each worktree (`BROWSER_CONTROL_SESSION` in every harness
 *     session's environment, see `tmux/inner-process.ts`) so an agent
 *     that browses is attributed without being told, and deletes it on
 *     destroy.
 *  2. **The browser itself**, via AppleScript: close every tab parked on
 *     the dev PORT wt allocated this worktree.
 *
 * (2) exists because (1) is conditional in a way that is invisible from
 * outside: `session delete` closes the session's page only while the
 * relay still holds a live CDP target for it. The relay drops that
 * target the moment the debugger detaches — opening DevTools on the tab,
 * clicking "Cancel" on Chrome's debugging banner, restarting the browser
 * or the extension's service worker — and `markTargetDetached` clears it
 * permanently, for relay-opened tabs as much as adopted ones. After
 * that, `session delete` still succeeds, still reports the id, and
 * closes nothing; `pageUrl` goes null too, so wt's port rule stops
 * seeing the session as well. That is the whole bug: cleanup looked like
 * it worked while the tab quietly outlived the worktree.
 *
 * Every rule here matches something wt itself handed out — the `wt-`
 * session name it set, or the port it allocated. wt never closes a
 * session on a guess about its name, and never closes a tab on a guess
 * about its URL.
 *
 * DELIBERATE: the port sweep closes the tab whoever opened it, including
 * one the human attached by hand. That is a narrowing of the older "a
 * user's tab is released, never closed" promise, and it is the point —
 * the sweep only ever runs when that port's dev server is going away, so
 * every tab on it is already stranded on a refused port. Outside the
 * port, the promise stands: `session delete` still releases adopted tabs
 * rather than closing them.
 *
 * KNOWN LIMIT: a detached tab that is NOT on the dev port (a staging URL,
 * a PR page an agent opened) has no handle left — browser-control exposes
 * no way to enumerate or close a tab it isn't attached to, and wt will
 * not close a tab by guessing at its URL. Those survive their worktree.
 *
 * Every failure here is swallowed. A browser tab is not worth failing a
 * teardown over, and the common "failures" are ordinary: browser-control
 * isn't installed, the relay isn't running, the agent never browsed, no
 * Chromium browser is open.
 */
import { Effect } from "effect";

import { createLogger } from "./logger.ts";
import { runEffect } from "./proc.ts";

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
 * Whether a URL is parked on `port` of the loopback host — the SECOND
 * ownership rule, and the one that doesn't depend on who named the
 * session. wt allocates each worktree a stable dev port and pins the
 * server to it, so a page on `localhost:<that port>` is that worktree's
 * dev server by construction, whoever opened it. That matters because
 * the sessions actually sitting on those ports are routinely named by
 * login/setup scripts (`czlogin8105`), never by wt, so the `wt-` prefix
 * rule can't see them at all.
 *
 * Used for both mechanisms: against a session's `pageUrl` to decide
 * which sessions to delete, and against a browser tab's URL to decide
 * which tabs to close. Parsing (rather than prefix-matching) is what
 * keeps `81050` and `https://evil.test/?next=http://localhost:8105/`
 * from reading as port 8105.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function urlOnDevPort(pageUrl: string | null, port: number): boolean {
  if (!pageUrl) return false;
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false;
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
function liveSessionsEffect(): Effect.Effect<BrowserSession[] | null> {
  if (!Bun.which(BIN)) return Effect.succeed(null);
  return runEffect([BIN, "status", "--json"], { timeoutMs: 5000 }).pipe(
    Effect.map((res) => {
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
        .filter(
          (s): s is { id: string; pageUrl?: unknown } =>
            typeof s.id === "string",
        )
        .map((s) => ({
          id: s.id,
          pageUrl: typeof s.pageUrl === "string" ? s.pageUrl : null,
        }));
    }),
    Effect.catch(() => Effect.succeed(null)),
  );
}

/** Delete the given sessions, returning the ids that actually went. */
function deleteSessionsEffect(ids: readonly string[]): Effect.Effect<string[]> {
  return Effect.forEach(
    ids,
    (id) =>
      runEffect([BIN, "session", "delete", id], { timeoutMs: 10_000 }).pipe(
        Effect.map((res) => {
          if (res.exitCode === 0) return id;
          log.debug("browser session delete failed", {
            id,
            stderr: res.stderr.trim(),
          });
          return null;
        }),
        Effect.catch((error) => {
          log.debug("browser session delete failed", {
            id,
            stderr: error.message,
          });
          return Effect.succeed(null);
        }),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((ids) => ids.filter((id): id is string => id !== null)));
}

/**
 * What a cleanup pass actually did. Both numbers are "real work done",
 * so a caller can stay silent when there was none — which is the common
 * case, and the reason this isn't logged from in here.
 */
export type BrowserCleanup = {
  /** browser-control session ids deleted. */
  sessions: string[];
  /** Browser tabs closed on the dev port, across every Chromium app. */
  tabs: number;
};

/**
 * Close the browser tabs belonging to a worktree that is going away:
 * the sessions wt named for it, plus anything parked on its dev port
 * (see `urlOnDevPort` — the login-script sessions are the ones actually
 * holding the app open, and they carry nobody's prefix), plus a sweep of
 * the browser's own tabs on that port for the ones browser-control has
 * lost its grip on.
 */
export function closeWorktreeBrowserSessionsEffect(
  slug: string,
  devPort?: number | null,
): Effect.Effect<BrowserCleanup> {
  return closeBrowserTabs(
    slug,
    devPort ?? null,
    (s) =>
      ownsBrowserSession(slug, s.id) || (devPort != null && urlOnDevPort(s.pageUrl, devPort)),
  );
}

export function closeWorktreeBrowserSessions(
  slug: string,
  devPort?: number | null,
): Promise<BrowserCleanup> {
  return Effect.runPromise(closeWorktreeBrowserSessionsEffect(slug, devPort));
}

/**
 * Close the tabs a worktree's dev server was serving, by dev port only.
 * Stopping the server strands them on a refused port, so they're dead
 * weight the moment it goes down — and unlike destroy, this must NOT
 * touch the worktree's other sessions: an agent's reference tabs, a PR
 * page, anything it opened that has nothing to do with the server.
 */
export function closeDevServerBrowserSessionsEffect(
  slug: string,
  devPort: number,
): Effect.Effect<BrowserCleanup> {
  return closeBrowserTabs(slug, devPort, (s) => urlOnDevPort(s.pageUrl, devPort));
}

export function closeDevServerBrowserSessions(
  slug: string,
  devPort: number,
): Promise<BrowserCleanup> {
  return Effect.runPromise(closeDevServerBrowserSessionsEffect(slug, devPort));
}

/**
 * Sessions first, then the port sweep. Order matters: deleting the
 * session closes the tab itself whenever the relay still holds its
 * target, which keeps the sweep's job down to the ones it lost — and
 * leaves the session record cleaned up either way.
 */
function closeBrowserTabs(
  slug: string,
  devPort: number | null,
  owned: (session: BrowserSession) => boolean,
): Effect.Effect<BrowserCleanup> {
  return Effect.gen(function* () {
    const live = yield* liveSessionsEffect();
    const sessions = live === null
      ? []
      : yield* deleteSessionsEffect(live.filter(owned).map((s) => s.id));
    const tabs = devPort === null ? 0 : yield* closeTabsOnPortEffect(devPort);
    if (sessions.length > 0 || tabs > 0) {
      log.info("closed browser sessions", { slug, sessions, tabs });
    }
    return { sessions, tabs };
  });
}

// ---------------------------------------------------------------------
// The browser itself. Everything below talks to the Chromium apps over
// AppleScript, with no browser-control involvement — this is the half
// that closes a tab the relay has lost its CDP target for, which is the
// only state a leaked tab is ever in.
// ---------------------------------------------------------------------

/**
 * Chromium-family browsers that can host the Browser Control extension,
 * by macOS application name. Firefox and Safari are absent on purpose:
 * the extension is Chromium-only, so a tab there was never wt's.
 *
 * These are matched against RUNNING process names before any AppleScript
 * is compiled. That check isn't an optimization — `tell application "X"`
 * is resolved at COMPILE time, so naming an app that isn't installed
 * fails the whole script, and the app name can't be a variable either
 * (the terminology for `tabs`/`URL` wouldn't load). Hence: one script
 * per running app, each with its name baked in.
 */
const CHROMIUM_APPS = [
  "Brave Browser",
  "Google Chrome",
  "Google Chrome Canary",
  "Google Chrome Beta",
  "Google Chrome Dev",
  "Chromium",
  "Microsoft Edge",
  "Vivaldi",
  "Opera",
  "Arc",
] as const;

/** Running Chromium apps, by the name AppleScript addresses them with. */
function runningChromiumAppsEffect(): Effect.Effect<string[]> {
  return runEffect(["ps", "-Aco", "command"], { timeoutMs: 5000 }).pipe(
    Effect.map((res) => {
      if (res.exitCode !== 0) return [];
      const running = new Set(res.stdout.split("\n").map((l) => l.trim()));
      return CHROMIUM_APPS.filter((app) => running.has(app));
    }),
    Effect.catch(() => Effect.succeed([])),
  );
}

/** Escape for embedding in an AppleScript string literal. */
function asQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * macOS error -1743 is "the human hasn't granted this terminal
 * permission to drive that app" — the one AppleScript failure that never
 * fixes itself, and the one whose symptom (tabs quietly surviving their
 * worktree) points nowhere near its cause. Said once per process, on the
 * pane rather than only the file, because it needs a trip to System
 * Settings › Privacy & Security › Automation.
 */
let warnedUnauthorized = false;

function warnIfUnauthorized(app: string, stderr: string): void {
  if (warnedUnauthorized || !stderr.includes("-1743")) return;
  warnedUnauthorized = true;
  log.event.warn(
    `can't close ${app} tabs: grant this terminal Automation access in System Settings › Privacy & Security`,
    { toast: true },
  );
}

/**
 * Every tab URL open in `app`, in no particular order. Reading first and
 * deciding in TypeScript (rather than matching inside the script) is
 * what keeps the ownership rule in ONE place — `urlOnDevPort`, which is
 * unit-tested — instead of a second copy written in AppleScript that
 * nothing checks.
 */
function tabUrlsEffect(app: string): Effect.Effect<string[]> {
  const script = `tell application ${asQuote(app)}
  set out to ""
  repeat with w in windows
    repeat with t in tabs of w
      set out to out & (URL of t) & linefeed
    end repeat
  end repeat
  return out
end tell`;
  // Longer than the close call gets: this one is O(tabs) over AppleScript's
  // per-tab round trip, so a browser with a few hundred tabs open is the
  // realistic way to time out — and timing out here silently skips the
  // whole app. Affordable because the apps run concurrently.
  return runEffect(["osascript", "-"], {
    input: script,
    timeoutMs: 15_000,
  }).pipe(
    Effect.map((res) => {
      if (res.exitCode !== 0) {
        warnIfUnauthorized(app, res.stderr);
        log.debug("browser tab list failed", {
          app,
          stderr: res.stderr.trim(),
        });
        return [];
      }
      return res.stdout.split("\n").filter((u) => u.length > 0);
    }),
    Effect.catch((error) => {
      log.debug("browser tab list failed", { app, stderr: error.message });
      return Effect.succeed([]);
    }),
  );
}

/**
 * Close every tab of `app` whose URL is one of `urls`, returning how
 * many went. Closing by URL rather than by the index we read it at is
 * deliberate: indices shift as tabs close, and the user may reorder or
 * close tabs mid-sweep, so an index is a stale handle while a URL can
 * only ever match the tab it describes.
 *
 * BOTH loops count DOWN over a static index, and the outer one is the
 * subtle half: closing the last tab of a window closes the WINDOW, and
 * `repeat with w in windows` walks a live element collection that then
 * shrinks underneath it — the next iteration throws -1719 and aborts the
 * script, leaving every later doomed tab open while `run` reports a
 * failure the caller swallows. A dev-server tab in its own window is an
 * ordinary shape, so that's the common case, not the exotic one.
 */
function closeTabsWithUrlsEffect(
  app: string,
  urls: readonly string[],
): Effect.Effect<number> {
  const list = urls.map(asQuote).join(", ");
  const script = `set doomed to {${list}}
set closedCount to 0
tell application ${asQuote(app)}
  repeat with wi from (count of windows) to 1 by -1
    set w to window wi
    repeat with i from (count of tabs of w) to 1 by -1
      set u to (URL of tab i of w) as text
      if doomed contains u then
        close tab i of w
        set closedCount to closedCount + 1
      end if
    end repeat
  end repeat
end tell
return closedCount`;
  return runEffect(["osascript", "-"], { input: script, timeoutMs: 5000 }).pipe(
    Effect.map((res) => {
      if (res.exitCode !== 0) {
        log.debug("browser tab close failed", {
          app,
          stderr: res.stderr.trim(),
        });
        return 0;
      }
      return Number.parseInt(res.stdout.trim(), 10) || 0;
    }),
    Effect.catch((error) => {
      log.debug("browser tab close failed", { app, stderr: error.message });
      return Effect.succeed(0);
    }),
  );
}

/**
 * Close every tab parked on `port` of the loopback host, across every
 * running Chromium browser. Best-effort and silent: no browser open, no
 * matching tab, or no Automation permission all come back as zero.
 *
 * The permission case is the one worth a word. macOS gates AppleScript
 * between apps behind a per-pair TCC grant, so the first sweep prompts
 * the human and a denial is permanent until they revisit System
 * Settings. It surfaces on `log.event.warn` rather than being swallowed
 * with the rest, because the symptom otherwise is tabs quietly piling
 * up with nothing anywhere saying why.
 */
function closeTabsOnPortEffect(port: number): Effect.Effect<number> {
  // Per app, concurrently: the apps are independent, and this is awaited
  // by a destroy the human is watching. Serially, someone running Chrome
  // + Brave + Arc pays each one's timeout in turn.
  return Effect.gen(function* () {
    const apps = yield* runningChromiumAppsEffect();
    const perApp = yield* Effect.forEach(
      apps,
      (app) =>
        Effect.gen(function* () {
          const doomed = (yield* tabUrlsEffect(app)).filter((u) =>
            urlOnDevPort(u, port),
          );
          return doomed.length === 0
            ? 0
            : yield* closeTabsWithUrlsEffect(app, doomed);
        }),
      { concurrency: 4 },
    );
    return perApp.reduce((a, b) => a + b, 0);
  });
}
