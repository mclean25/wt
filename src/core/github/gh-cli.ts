import { Effect } from "effect";

import { config } from "../config.ts";
import { createLogger } from "../logger.ts";
import { runEffect } from "../proc.ts";

const log = createLogger("[gh]");

// `which gh` is memoized so per-slice loops (stack status/rebase) don't
// re-spawn it each call — but only the POSITIVE result. A cached negative
// would pin "no gh" for the whole session even after the user installs it;
// re-probing in gh-absent mode is cheap (everything gh-backed is off anyway).
let _hasGh: boolean | undefined;
export function hasGhEffect(): Effect.Effect<boolean> {
  if (_hasGh) return Effect.succeed(true);
  return runEffect(["which", "gh"]).pipe(
    Effect.map((r) => {
      const found = r.exitCode === 0 && r.stdout.trim().length > 0;
      if (found) _hasGh = true;
      return found;
    }),
    Effect.catch(() => Effect.succeed(false)),
  );
}

export function hasGh(): Promise<boolean> {
  return Effect.runPromise(hasGhEffect());
}

// Cache the resolved `owner/name` — it never changes for a given clone.
// Same positive-only rule as `hasGh`: a transient failure (gh not yet
// authed at startup) shouldn't pin null for the whole session.
let _repoSlug: string | null | undefined;
export function repoSlugEffect(): Effect.Effect<string | null> {
  if (_repoSlug != null) return Effect.succeed(_repoSlug);
  return runEffect(["gh", "repo", "view", "--json", "nameWithOwner"], {
    cwd: config.paths.mainClone,
    timeoutMs: 5_000,
  }).pipe(
    Effect.map((r) => {
      if (r.exitCode !== 0) return null;
      try {
        const data = JSON.parse(r.stdout) as { nameWithOwner?: string };
        _repoSlug = data.nameWithOwner ?? null;
        return _repoSlug;
      } catch (err) {
        log.error(err instanceof Error ? err : String(err), {
          stdout: r.stdout.slice(0, 200),
        });
        return null;
      }
    }),
    Effect.catch(() => Effect.succeed(null)),
  );
}

export function repoSlug(): Promise<string | null> {
  return Effect.runPromise(repoSlugEffect());
}

/**
 * The currently-authenticated GitHub user's login. Cached for the
 * life of the process — gh auth doesn't change while the TUI is
 * running. Used to filter the user out of reviewer pickers (you
 * can't review your own PR).
 */
let _authedLogin: string | null | undefined;
export function fetchAuthenticatedLoginEffect(): Effect.Effect<string | null> {
  // Positive-only memo (see `hasGh`): a failed probe (not yet authed)
  // re-tries on the next call instead of pinning null all session.
  if (_authedLogin != null) return Effect.succeed(_authedLogin);
  return Effect.gen(function* () {
    if (!(yield* hasGhEffect())) return null;
    const r = yield* runEffect(["gh", "api", "user", "--jq", ".login"], {
      cwd: config.paths.mainClone,
      timeoutMs: 5_000,
    }).pipe(Effect.catch(() => Effect.succeed(null)));
    if (r === null || r.exitCode !== 0) {
      if (r) {
        log.error("auth user fetch failed", { stderr: r.stderr.slice(0, 200) });
      }
      return null;
    }
    const login = r.stdout.trim();
    if (login.length > 0) _authedLogin = login;
    return _authedLogin ?? null;
  });
}

export function fetchAuthenticatedLogin(): Promise<string | null> {
  return Effect.runPromise(fetchAuthenticatedLoginEffect());
}
