import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import { clearArchived } from "./archive.ts";
import { clearClaudeNames } from "./harness/claude/names.ts";
import { clearCodexNames } from "./harness/codex/names.ts";
import { untrustCodexWorkspace } from "./harness/codex/trust.ts";
import { clearOpencodeNames } from "./harness/opencode/names.ts";
import {
  clearRemovedWorktree,
  clearSlugState,
  recordRemovedWorktrees,
  reparentBaseReferences,
  setSlugBase,
} from "./wtstate.ts";
import { getBackend, getBackendForPath } from "./backend.ts";
import { closeWorktreeBrowserSessions } from "./browser.ts";
import { config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { clearDevServerFiles } from "./dev-server.ts";
import { resolveInstallCommand } from "./install.ts";
import { branchExists, git, gitQuiet, originBranchExists, revParse } from "./git.ts";
import { ISSUE_ID_RE, ISSUE_URL_RE } from "./issue-tracker.ts";
import { lockLabel, lockStatus, tryAcquireLock } from "./locks.ts";
import { runStreaming } from "./proc.ts";
import { reapWorktreeListeners } from "./reaper.ts";
import { RESERVED_SESSION_SLUGS } from "./tmux/naming.ts";
import { computeStage, dirSlug, slugify } from "./stage.ts";
import { adjectives, animals, uniqueNamesGenerator } from "unique-names-generator";
import { safeStage } from "./stage-safety.ts";
import type { Worktree } from "./types.ts";
import { fetchOrigin } from "./worktree.ts";

/**
 * How long `removeWorktree` waits out a transient lock holder before
 * giving up. Sized to outlast a restack `reconcileStack`'s live `gh pr
 * view` probes (held under the chain lock), which the automation
 * clean-then-restack path races. Well short of a genuinely long-held
 * operation lock, which still fails so the destroy doesn't hang.
 */
const LOCK_ACQUIRE_WAIT_MS = 8000;

const log = createLogger("[lifecycle]");

export type CreateResult =
  | { ok: true; path: string; branch: string; stage: string; slug: string }
  | { ok: false; reason: string };

/**
 * Return branches matching `<prefix>/<issue-id>(-|$)`. When `anyAuthor`
 * is set, `<prefix>` is any single path segment; otherwise it's the
 * user's own `config.branch.prefix`. Results are deduped so `origin/X`
 * and local `X` collapse to a single entry (local preferred implicitly
 * — `git branch -a` lists locals before remotes in typical output).
 */
export async function findBranchesForIssue(
  issueLower: string,
  opts: { anyAuthor?: boolean } = {},
): Promise<string[]> {
  const out = await git(["branch", "-a", "--format=%(refname:short)"]).catch(
    () => "",
  );
  // In strict mode we only accept `<michael>/<id>-...`. With anyAuthor
  // we relax to "id appears at a word boundary anywhere in the branch
  // name" — this catches non-standard layouts like
  // `worktree-david+eng-4959-...` that don't use `/` as the separator.
  // The picker modal handles false positives gracefully.
  const pattern = opts.anyAuthor
    ? new RegExp(
        `(?:^|[^a-z0-9])${escapeRegex(issueLower)}(?:-|$)`,
        "i",
      )
    : new RegExp(
        `^(?:origin/)?${escapeRegex(config.branch.prefix)}/${escapeRegex(issueLower)}(?:-|$)`,
      );
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const raw of out.split("\n")) {
    if (!pattern.test(raw)) continue;
    const normalized = raw.replace(/^origin\//, "");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    branches.push(normalized);
  }
  return branches;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Readable random suffix (`cozy-elephant`) for a bare-id `wt new`,
 * retried until the resulting branch is free. ~29k combos; if all five
 * draws collide something is deeply wrong, so give up loudly.
 */
async function randomFreeSuffix(idLower: string): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const suffix = uniqueNamesGenerator({
      dictionaries: [adjectives, animals],
      separator: "-",
      length: 2,
      style: "lowerCase",
    });
    if (!(await branchExists(`${config.branch.prefix}/${idLower}-${suffix}`))) {
      return suffix;
    }
  }
  throw new Error(`couldn't find a free random slug for ${idLower} (tried 5)`);
}

export type ParseInputOptions = {
  slugHint?: string;
  /**
   * Widen the issue-ID search to branches from any author
   * (`<anyone>/<id>-...`). Without this, only `michael/` matches.
   */
  anyAuthor?: boolean;
  /**
   * Attach to an existing branch for the id instead of minting a new
   * one (`--attach`): one match checks out, several go through
   * `promptForChoice`, none is an error. Without it, an id always
   * creates a fresh branch (repeat entries = more worktrees).
   */
  attach?: boolean;
  /**
   * Pick one when multiple branches match (e.g. pair-programming
   * across authors). If omitted and there are multiple matches,
   * parseInput throws.
   */
  promptForChoice?: (id: string, branches: string[]) => Promise<string | null>;
};

export async function parseInput(
  raw: string,
  opts: ParseInputOptions = {},
): Promise<string> {
  raw = raw.trim();
  if (!raw) throw new Error("empty input");

  // "<ID> [title words…]" — a leading issue id, optionally followed by
  // pasted title text that becomes the slug. There is no tracker API:
  // the id (and title, when the user pastes one) is all wt ever gets.
  // A leading tracker URL reduces to its id first, so "URL note" and
  // "ID note" behave identically.
  const tokens = raw.split(/\s+/);
  const urlMatch = ISSUE_URL_RE.exec(tokens[0]!);
  if (urlMatch && urlMatch[1]) tokens[0] = urlMatch[1].toUpperCase();
  if (ISSUE_ID_RE.test(tokens[0]!)) {
    const id = tokens[0]!.toUpperCase();
    const idLower = id.toLowerCase();
    if (opts.attach) {
      const found = await findBranchesForIssue(idLower, { anyAuthor: opts.anyAuthor });
      if (found.length === 1) return found[0]!;
      if (found.length > 1) {
        if (opts.promptForChoice) {
          const picked = await opts.promptForChoice(id, found);
          if (!picked) throw new Error(`no branch chosen for ${id}`);
          return picked;
        }
        throw new Error(
          `Multiple branches for ${id}: ${found.join(", ")}. Pass the branch explicitly.`,
        );
      }
      throw new Error(`No existing branch for ${id} to attach to.`);
    }
    // Minting a new branch: the primary id must carry the configured
    // tracker prefix. A GitHub issue is a SECONDARY id (`--gh <n>`),
    // never a worktree's identity.
    const required = config.issueTracker?.prefix;
    const prefix = idLower.slice(0, idLower.indexOf("-"));
    if (required && prefix !== required) {
      throw new Error(
        `${id} can't lead a worktree ([issue_tracker] prefix = "${required}"). ` +
          `Use \`wt new ${required.toUpperCase()}-NNNN …${prefix === "gh" ? ` --gh ${id.slice(3)}` : ""}\`, ` +
          `an issue-less slug, or --attach for an existing branch.`,
      );
    }
    // An explicit slug (--slug, which wins, or inline title words)
    // names the branch; a bare id gets a random readable suffix
    // (`coz-1234-cozy-elephant`) so repeat entries never collide and
    // no bare `coz-1234` branch exists to shadow later lookups.
    // Slugified-to-nothing text (e.g. "!!!") counts as bare.
    const slug = slugify(opts.slugHint ?? tokens.slice(1).join(" "));
    if (slug) {
      return `${config.branch.prefix}/${idLower}-${slug}`;
    }
    return `${config.branch.prefix}/${idLower}-${await randomFreeSuffix(idLower)}`;
  }

  // Branch-shaped input (single token with a `/`) passes through as-is.
  if (tokens.length === 1 && raw.includes("/")) return raw;
  // Exact-match escape hatch: if the raw input names a real branch
  // (local or origin), attach to it instead of minting a fresh
  // `michael/<slug>`. Covers non-standard names without a `/`
  // separator (e.g. `worktree-david+eng-4959-...`).
  if (tokens.length === 1 && (await branchExists(raw))) return raw;
  // Anything else — including multiple words ("fix the calendar") —
  // slugifies into a fresh `<prefix>/<slug>` branch.
  return `${config.branch.prefix}/${slugify(raw)}`;
}

export type CreateOptions = {
  onPhase?: (phase: string) => void;
  onLog?: (line: string) => void;
  runInstall?: boolean; // default true
  /**
   * Base ref for a *new* branch (e.g. `origin/main`, `michael/eng-4999`).
   * Ignored when the branch already exists — in that case we check out
   * the existing branch as-is.
   */
  base?: string;
};

export async function createWorktree(
  branch: string,
  opts: CreateOptions = {},
): Promise<CreateResult> {
  const slug = dirSlug(branch);
  const path = join(config.paths.worktreeRoot, slug);
  const stage = computeStage(slug);

  // Slot sessions (wt source, main clone, dotfiles, manager) share the
  // tmux namespace with worktree slugs — a worktree slugged "manager"
  // would receive the fleet coordinator's injections. Refuse up front.
  if (RESERVED_SESSION_SLUGS.includes(slug)) {
    return {
      ok: false,
      reason: `"${slug}" is a reserved session name (${RESERVED_SESSION_SLUGS.join(", ")}) — pick different title words`,
    };
  }

  if (existsSync(path)) {
    return { ok: false, reason: `Path already exists: ${path}` };
  }

  mkdirSync(config.paths.worktreeRoot, { recursive: true });

  const handle = tryAcquireLock(slug, "init", { phase: "preparing" });
  if (!handle) {
    return { ok: false, reason: `Another wt process is busy with ${slug}` };
  }

  // Reset any stale archive / state.json entry left over from a prior
  // destroy of the same slug. Done after lock acquire so a racing
  // destroy of the same slug (would have failed `tryAcquireLock` above)
  // can't have its archive entry wiped from under it. We deliberately
  // don't clean these up at destroy time: clearing archive.json while
  // the parent TUI's worktreesQuery cache still includes the row makes
  // the row "un-archive" mid-destroy and flash back into the active
  // list. Clearing here, paired with the lock guarantee that no
  // destroy is in flight, is the race-free counterpart.
  clearArchived(slug);
  clearSlugState(slug);
  clearRemovedWorktree(slug);
  clearClaudeNames(slug);
  clearCodexNames(slug);
  clearOpencodeNames(slug);
  clearDevServerFiles(slug);

  try {
    const backend = getBackend(config.backend.kind);

    opts.onPhase?.("fetching origin");
    await fetchOrigin();

    handle.phase(`creating worktree (${backend.id})`);
    const existing = await branchExists(branch);
    if (existing && opts.base) {
      opts.onLog?.(`note: --base ignored, ${branch} already exists`);
    }
    // `null` baseRef == "check out the existing branch"; otherwise create
    // a new branch off this ref. The backend materializes the checkout on
    // the branch; wt does the upstream/fork-base wiring below (agnostic —
    // it runs git inside the new checkout, which holds for both a linked
    // worktree and an independent rift clone).
    const baseRef = existing ? null : opts.base ?? `origin/${config.branch.base}`;
    // When the base is a sibling branch (a stacked parent, i.e. not an
    // `origin/` ref), point the backend at that parent's worktree — the
    // rift backend fetches the base commits from it, since an independent
    // clone won't already have them. undefined for trunk/origin bases and
    // ignored by the git-worktree backend.
    let baseSourcePath: string | undefined;
    if (baseRef && !baseRef.startsWith("origin/")) {
      const cand = join(config.paths.worktreeRoot, dirSlug(baseRef));
      if (existsSync(cand)) baseSourcePath = cand;
    }
    await backend.create({
      path,
      branch,
      slug,
      baseRef,
      baseSourcePath,
      mainClone: config.paths.mainClone,
      onLog: opts.onLog,
    });

    if (existing) {
      if (
        (await originBranchExists(branch, path)) &&
        !(await gitQuiet(["rev-parse", "--abbrev-ref", "@{u}"], path))
      ) {
        await gitQuiet(["branch", "--set-upstream-to", `origin/${branch}`], path);
      }
    } else if (baseRef) {
      // Remember a non-trunk fork base. This record IS the stack
      // primitive: it drives the TUI's stack grouping, the diff base,
      // and the restack replay. Stored as a plain branch name so it can
      // match a sibling worktree; the fork-point sha captured now is
      // the squash-safe anchor a later restack replays from.
      const baseBranch = baseRef.replace(/^origin\//, "");
      if (baseBranch !== config.branch.base) {
        const sha = await revParse("HEAD", path);
        setSlugBase(slug, { branch: baseBranch, sha: sha ?? undefined });
        opts.onLog?.(`recorded fork base ${baseBranch}`);
      }
    }

    handle.phase("copying env files");
    for (const name of config.lifecycle.envFilesToCopy) {
      const src = join(config.paths.mainClone, name);
      const dst = join(path, name);
      if (existsSync(src) && !existsSync(dst)) {
        copyFileSync(src, dst);
        opts.onLog?.(`copied ${name}`);
      }
    }

    if (config.lifecycle.copyGlobs.length > 0) {
      handle.phase("copying configured files");
      const copied = new Set<string>();
      for (const pattern of config.lifecycle.copyGlobs) {
        const glob = new Bun.Glob(pattern);
        for (const relativePath of glob.scanSync({
          cwd: config.paths.mainClone,
          dot: true,
          onlyFiles: true,
        })) {
          const normalizedPath = normalize(relativePath);
          if (/^\.git(?:[\\/]|$)/.test(normalizedPath)) continue;
          if (copied.has(normalizedPath)) continue;
          copied.add(normalizedPath);
          const src = join(config.paths.mainClone, normalizedPath);
          const dst = join(path, normalizedPath);
          if (existsSync(dst)) continue;
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(src, dst);
          opts.onLog?.(`copied ${normalizedPath}`);
        }
      }
    }

    // Stage pinning only means something with an SST integration —
    // without [deploy.sst] nothing can ever read the pinned name
    // (`wt stages` refuses, the stage row hides), so skip the write and
    // the log line rather than reporting work that did nothing.
    if (config.sst) {
      handle.phase("pinning sst stage");
      const sstDir = join(path, ".sst");
      mkdirSync(sstDir, { recursive: true });
      writeFileSync(join(sstDir, "stage"), `${stage}\n`);
      opts.onLog?.(`pinned sst stage → ${stage}`);
    }

    // The rift backend copies packages across via its CoW clone
    // (`--copy-all`), so wt's own install is redundant — packages are
    // always present without a fresh install, and any lockfile sync is
    // left to rift's `.rift.toml` postcreate hooks. `--no-install`
    // / `runInstall` is therefore a no-op here (ignored, not an error).
    if (backend.id === "rift") {
      opts.onLog?.("packages copied via rift clone (skipping install)");
    } else if (opts.runInstall !== false) {
      const install = resolveInstallCommand(path);
      if (!install) {
        opts.onLog?.(
          "no lockfile found — skipping install (set [lifecycle] install_command to override)",
        );
      } else {
        handle.phase(install.label);
        opts.onLog?.(`${install.label}...`);
        const code = await runStreaming(install.argv, {
          cwd: path,
          onLine: (line) => opts.onLog?.(line),
        });
        if (code !== 0) {
          throw new Error(`${install.label} exit ${code}`);
        }
      }
    }
  } catch (err) {
    // Backend and setup failures THROW (the rift backend rolls back its
    // partial clone first). Fold them into the `ok: false` contract so
    // every caller's existing failure path (CLI stderr, TUI toast +
    // attention line) surfaces the reason — an escaped rejection here
    // used to leave the flashed-and-vanished row with no explanation.
    // The reason string carries only the message; keep the stack in the
    // daily log or an unexpected TypeError here is unroot-causeable.
    log.error(err instanceof Error ? err : String(err), { slug });
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    handle.release();
  }

  return { ok: true, path, branch, stage, slug };
}

export type RemoveOptions = {
  force?: boolean;
  destroyStage?: boolean;
  deleteBranch?: boolean;
  onPhase?: (phase: string) => void;
  onLog?: (line: string) => void;
};

export type RemoveResult = {
  ok: boolean;
  message: string;
  destroyedStage: boolean;
  deletedBranch: boolean;
};

/**
 * Foreground remove. Assumes caller already confirmed dirty-prompts
 * and resolved the destroyStage / deleteBranch decisions.
 */
export async function removeWorktree(
  wt: Worktree,
  opts: RemoveOptions = {},
): Promise<RemoveResult> {
  const { force = false, destroyStage = false, deleteBranch = false } = opts;

  // Acquire the per-slug lock, retrying briefly rather than failing on the
  // first miss. A concurrent reader can hold this flock transiently — most
  // notably a restack's `reconcileStack`, which probes each parent's PR
  // state with a LIVE `gh pr view` while holding the whole chain's locks.
  // When an automation cleans a merged member and restacks the survivor in
  // the same dispatch, the detached `wt _destroy` child reaches this line
  // right as reconcile is mid-probe on that member; a single try loses the
  // race and strands the worktree (its clean-fire already consumed). A
  // teardown about to run for seconds shouldn't abort over a sub-second
  // race, so wait out a transient holder. Bounded so a genuinely long-held
  // lock (another destroy, a replay of this very worktree) still fails.
  let handle = tryAcquireLock(wt.slug, "remove", { phase: "preparing" });
  if (!handle) {
    const deadline = Date.now() + LOCK_ACQUIRE_WAIT_MS;
    while (!handle && Date.now() < deadline) {
      await Bun.sleep(150 + Math.floor(Math.random() * 150));
      handle = tryAcquireLock(wt.slug, "remove", { phase: "preparing" });
    }
  }
  if (!handle) {
    const existing = lockStatus(wt.slug);
    return {
      ok: false,
      message: existing
        ? `${wt.slug} is busy: ${lockLabel(existing)}`
        : `could not lock ${wt.slug}`,
      destroyedStage: false,
      deletedBranch: false,
    };
  }

  let effectiveForce = force;
  let destroyedStage = false;
  let deletedBranch = false;
  try {
    if (destroyStage) {
      // Central safety gate. `safe.stage` is the pinned `.sst/stage`,
      // accepted only when it carries the personal prefix — so the
      // destroy targets what's actually deployed but can never point at
      // a foreign (e.g. production) stage outside our namespace.
      const safe = safeStage(wt);
      if (!safe.ok) {
        opts.onPhase?.("sst remove (skipped)");
        handle.phase("sst remove (skipped)");
        opts.onLog?.(`refusing sst remove: ${safe.reason}`);
      } else {
        opts.onPhase?.("sst remove");
        handle.phase("sst remove");
        opts.onLog?.(`pnpm sst remove --stage ${safe.stage}`);
        const sstExit = await runStreaming(
          ["pnpm", "sst", "remove", "--stage", safe.stage],
          {
            cwd: wt.path,
            onLine: (line) => opts.onLog?.(line),
          },
        );
        if (sstExit === 0) {
          destroyedStage = true;
          // sst regenerates tracked files; bypass git's dirty check.
          effectiveForce = true;
        } else {
          opts.onLog?.(`sst remove failed (exit ${sstExit})`);
        }
      }
    }

    // Reap hand-started servers (an agent's `pnpm preview`, a stray
    // vite) BEFORE the checkout goes away: lsof resolves each process's
    // cwd against the still-existing directory, and a freed port can't
    // outlive the worktree. This deliberately differs from the browser
    // cleanup below (which waits for the remove to succeed): a killed
    // preview server on a destroy that then bails is one command to
    // restart, while a closed tab's state is gone for good. wt-managed
    // sessions are already dead by now (callers run killAllSessionsFor
    // first), so this only ever sees processes wt doesn't manage.
    const reaped = await reapWorktreeListeners(wt.path);
    for (const p of reaped) {
      opts.onLog?.(`reaped ${p.command} (pid ${p.pid}, port ${p.ports.join(", ") || "?"})`);
    }

    // Dispatch on the checkout's ACTUAL backend (derived from disk), not
    // the config's current `kind` — a rift checkout must be torn down
    // with rift even after the user flips the default back to git, and
    // vice versa.
    const backend = getBackendForPath(wt.path);
    opts.onPhase?.(`worktree remove (${backend.id})`);
    handle.phase(`worktree remove (${backend.id})`);
    const removed = await backend.remove({
      path: wt.path,
      slug: wt.slug,
      force: effectiveForce,
      mainClone: config.paths.mainClone,
      onLog: opts.onLog,
    });
    if (!removed.ok) {
      return {
        ok: false,
        message: removed.message ?? "failed",
        destroyedStage,
        deletedBranch,
      };
    }

    // Only now that the checkout is definitely gone — a destroy that
    // bailed above leaves a worktree the user is still working in, and
    // closing its tabs would be pure loss. Best-effort and silent when
    // there was nothing to close, which is the common case.
    const closedTabs = await closeWorktreeBrowserSessions(wt.slug);
    if (closedTabs.length > 0) {
      opts.onLog?.(`closed browser session ${closedTabs.join(", ")}`);
    }

    if (wt.branch && backend.id === "rift") {
      // A rift branch lives ONLY inside the (now-removed) clone's own
      // `.git`, so it's gone with the checkout unconditionally — there's
      // no shared main-clone ref, and `--keep-branch` can't preserve it
      // (unlike a git-worktree branch, whose ref survives in the shared
      // db). Mark it gone regardless of the deleteBranch flag so
      // dependents always reparent below instead of dangling on a branch
      // that no longer resolves. (The CLI's `decideDeleteBranch` also
      // returns false for a rift branch, since it's not in the main
      // clone — keying on the backend here makes this independent of it.)
      deletedBranch = true;
    } else if (deleteBranch && wt.branch && (await branchExists(wt.branch))) {
      handle.phase("deleting branch");
      if (await gitQuiet(["branch", "-D", wt.branch])) {
        deletedBranch = true;
      }
    }

    // The deleted branch may be some OTHER worktree's recorded fork
    // base. Reparent those records onto the deleted branch's own
    // recorded base (or trunk), PRESERVING their baseSha anchors — the
    // usual reason a parent disappears is that it merged and got
    // cleaned, and the kept anchor is what lets the next restack replay
    // the dependents squash-safely instead of re-applying the landed
    // parent's commits.
    if (deletedBranch && wt.branch) {
      const reparented = reparentBaseReferences(wt.branch, config.branch.base, wt.slug);
      if (reparented.length > 0) {
        opts.onLog?.(
          `reparented fork base on ${reparented.join(", ")} (was the deleted ${wt.branch})`,
        );
      }
    }

    // A rift checkout may have persisted a Codex trust entry (config.toml, a
    // stowed dotfiles file) when a codex session opened here; drop it so the
    // tracked config doesn't accumulate dead-workspace drift. No-op if none
    // was written. (Claude's ~/.claude.json entry is left — it's Claude's own
    // churny, untracked file, matching the fleet's teardown.)
    if (backend.id === "rift") {
      untrustCodexWorkspace(wt.path);
    }

    // Note: archive.json / state.json entries for THIS slug are NOT
    // cleared here. Doing so from the child process while the parent
    // TUI's worktreesQuery cache still includes this slug causes the
    // row to visibly "un-archive" mid-destroy: the archive query
    // refetches and sees the slug gone, but the worktrees list still
    // has it, so the row pops into the active section as merged/gone
    // until the next worktrees refetch. The fresh-start guarantee for
    // re-creates lives in createWorktree (which clears both files for
    // the new slug); the stale-entry sweep for external destroys lives
    // in `reapStartup` so archive.json/state.json don't accumulate
    // ghosts. (Dependents' fork-base records were already reparented
    // above when the branch was deleted.)

    // Confirm the removal in the removed-worktrees history. The TUI's
    // destroy flows already wrote a rich snapshot (title, PR) at
    // dispatch; this minimal upsert preserves those fields and covers
    // the CLI paths that never went through the TUI. Best-effort — a
    // state-file IO failure must not fail an already-completed remove.
    if (wt.branch) {
      try {
        recordRemovedWorktrees([
          { slug: wt.slug, branch: wt.branch, removedAt: new Date().toISOString() },
        ]);
      } catch (err) {
        opts.onLog?.(
          `could not record removed-worktree entry: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      ok: true,
      message: `removed ${wt.slug}`,
      destroyedStage,
      deletedBranch,
    };
  } finally {
    handle.release();
  }
}

/**
 * Spawn a detached background process to run the destroy tail (including
 * `pnpm sst remove` when `destroyStage` is set).
 *
 * `detached: true` is load-bearing, not cosmetic. Without it the child shares
 * wt's process group + controlling terminal, so closing the terminal window
 * (or an SSH drop) delivers SIGHUP to the whole group and kills an in-flight
 * `sst remove` mid-teardown — a half-removed, stranded stage. setsid (what
 * `detached` triggers) gives the child its own session so the hangup can't
 * reach it; it runs to completion writing into the already-opened log fd.
 * `.unref()` then frees the child from wt's event loop (fire-and-forget; we
 * never await it). A clean wt quit was already survivable (the child reparents
 * to launchd), and a hard kill mid-remove just leaves an orphaned stage that
 * `categorizeStages` re-flags on next launch — the terminal-hangup hole was the
 * one that silently stranded work. This mirrors why actions run under tmux
 * (`core/tmux/action-sessions.ts`): destroy work must outlive the TUI.
 */
export function spawnBackgroundRemove(slug: string, opts: {
  force: boolean;
  destroyStage: boolean;
  deleteBranch: boolean;
}): string {
  mkdirSync(config.paths.logDir, { recursive: true });
  const logPath = join(
    config.paths.logDir,
    `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
  );
  const exe = join(import.meta.dir, "..", "..", "bin", "wt");
  // Open the log file in the parent and pass the fd to the child as
  // stdout+stderr. This captures not only the _destroy process's own
  // writes but also every grandchild (pnpm sst remove, git, etc.)
  // without leaking into the TUI's terminal.
  const fd = openSync(logPath, "a");
  try {
    const child = Bun.spawn(
      [
        exe,
        "_destroy",
        slug,
        "--force",
        String(opts.force),
        "--destroy-stage",
        String(opts.destroyStage),
        "--delete-branch",
        String(opts.deleteBranch),
      ],
      {
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        // Own session (setsid) so a terminal hangup can't SIGHUP the
        // in-flight `sst remove`. See the docstring above.
        detached: true,
      },
    );
    // Fire-and-forget: don't let the child hold wt's event loop open.
    child.unref();
  } finally {
    // Parent doesn't need the fd — the child has its own dup.
    closeSync(fd);
  }
  return logPath;
}
