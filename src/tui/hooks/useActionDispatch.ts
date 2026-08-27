/**
 * Action launch + completion dispatch, extracted from `app.tsx`.
 *
 * Owns the two halves of the custom-action lifecycle that must share
 * state (the `pendingArgs` map):
 *
 *  - `launchAction` — guard, render vars, and start (or inject) a run.
 *  - The action-registry subscriber — fans a finished run's `affects`
 *    tags out to the matching invalidation helpers and refines the
 *    arg-history label from the captured output.
 *
 * See rule (3) in the architecture block at the top of
 * `state/hooks.ts` for the `affects` contract.
 */
import { useEffect, useRef } from "react";

import {
  actionRegistry,
  applyVars,
  ALL_BUILTIN_ACTIONS,
  evaluateActionRequirements,
  type ActionDef,
  type ActionVars,
} from "../../core/actions.ts";
import { recordRun as recordHistoryRun } from "../../core/actions.ts";
import { config } from "../../core/config.ts";
import { getHarness, type HarnessId } from "../../core/harness/index.ts";
import { sendSessionMessage } from "../../core/harness/session-messaging.ts";
import { createLogger } from "../../core/logger.ts";
import { StatusKind } from "../../core/types.ts";
import { ensureManagerClaudeName, MANAGER_SLUG } from "../../core/manager.ts";
import { MANAGER_SLOT, SESSION_SLOTS } from "../sessions/slots.ts";

import {
  actionSkillPrefix,
  buildActionVars,
  extractLabel,
  launchBlockedReason,
} from "../app-helpers.ts";
import type { WorktreeRow } from "./useWorktreeRows.ts";
import { theme } from "../theme.ts";

export type ActionDispatchOpts = {
  rows: readonly WorktreeRow[];
  primaryHarness: HarnessId;
  toast: (message: string, color?: string, ms?: number) => void;
  /** Clear a worktree's output focus so auto-rules surface the run. */
  setFocus: (slug: string, patch: { focused: string | null }) => void;
  invalidateWorktree: (slug: string) => Promise<void>;
  refreshOrigin: () => Promise<void>;
  refreshGithub: () => Promise<void>;
  refreshStack: () => Promise<void>;
};

export type LaunchActionOpts = {
  /**
   * Fire keys of the automation dispatch launching this run. Stamped
   * into the headless run's meta.json so the automation ledger's boot
   * reconciliation can match a `dispatched` entry against a run that
   * really launched. Absent for manual launches.
   */
  autoFireKeys?: readonly string[];
};

/**
 * Did the launch actually hand work off? `launched: false` means a
 * guard declined it BEFORE anything ran (busy worktree, action already
 * running, unmet requirements, …) — for manual launches the toast is
 * the whole story, but the automations engine uses the distinction to
 * un-consume the fire instead of recording a run that never happened.
 * Session-target messages report `launched: true` at hand-off (delivery
 * is fire-and-forget by design).
 */
export type LaunchOutcome = { launched: boolean; reason?: string };

export function useActionDispatch(opts: ActionDispatchOpts): {
  launchAction: (
    slug: string,
    def: ActionDef | null,
    extras: string,
    arg?: string,
    launchOpts?: LaunchActionOpts,
  ) => Promise<LaunchOutcome>;
  launchSlotCommand: (
    slotSlug: string,
    def: ActionDef | null,
    extras: string,
  ) => Promise<LaunchOutcome>;
} {
  // Custom action effect dispatch — each action carries an `affects`
  // tag set captured at start time; on every transition from
  // `running` → terminal status, fan that out to the matching
  // invalidation helpers. The `handled` set keys on `slug@endedAt`
  // so a completion fires exactly once even when the registry
  // notifies for unrelated state churn afterwards.
  //
  // `handled` and the helper closures live in refs so the effect
  // subscribes exactly once at mount. The caller passes fresh helper
  // closures every render — without the ref indirection the deps
  // array would tear down + re-seed on every render, and a completion
  // that fires inside that window can be lost to the seed before
  // dispatch runs.
  const helpersRef = useRef({
    invalidateWorktree: opts.invalidateWorktree,
    refreshOrigin: opts.refreshOrigin,
    refreshGithub: opts.refreshGithub,
    refreshStack: opts.refreshStack,
  });
  helpersRef.current = {
    invalidateWorktree: opts.invalidateWorktree,
    refreshOrigin: opts.refreshOrigin,
    refreshGithub: opts.refreshGithub,
    refreshStack: opts.refreshStack,
  };
  const handledRef = useRef<Set<string>>(new Set());
  /**
   * Per-launch arg values, keyed by `${slug}/${actionId}`. Populated by
   * `launchAction` when an arg was supplied; consulted by the action-
   * registry subscriber once the matching run reaches a terminal status
   * to refine the just-written history entry via the def's
   * `label_extract` regex against the captured output. Cleared on
   * consumption — bounded by the number of concurrent in-flight runs.
   */
  const pendingArgs = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    const handled = handledRef.current;
    // Seed once with already-finished runs so a fresh mount doesn't
    // re-fire dispatch for runs the previous mount already handled.
    // (Singleton registry survives across mounts; ref survives across
    // renders. The seed is a no-op on a clean process start.)
    for (const run of actionRegistry.getSnapshot().values()) {
      if (run.status !== "running" && run.endedAt !== undefined) {
        handled.add(`${run.slug}@${run.endedAt}`);
      }
    }
    return actionRegistry.subscribe(() => {
      for (const run of actionRegistry.getSnapshot().values()) {
        if (run.status === "running") continue;
        if (run.endedAt === undefined) continue;
        const key = `${run.slug}@${run.endedAt}`;
        if (handled.has(key)) continue;
        handled.add(key);
        const {
          invalidateWorktree: inv,
          refreshOrigin: ro,
          refreshGithub: rg,
          refreshStack: rs,
        } = helpersRef.current;
        for (const tag of run.affects) {
          switch (tag) {
            case "git":
              void ro();
              void inv(run.slug);
              // History-rewriting actions (rebase, modify, …) rewrite
              // commits under a fixed explicit parent, so the per-base
              // diff / sync queries need a re-run even though the parent
              // relationship is unchanged. `refreshStack` invalidates
              // those (see its doc in state/hooks.ts).
              void rs();
              break;
            case "github":
              void rg();
              break;
            case "dev":
              // Dev-server start/stop — refresh the slug's per-worktree
              // fields so the dev row/bolt snap without waiting out the
              // staleTime. Slug-scoped; no cross-worktree state moved.
              void inv(run.slug);
              break;
            default: {
              // Exhaustiveness check — a new EffectTag without a case
              // here would silently skip its invalidation, leaving the
              // UI stale after the action exits.
              const _exhaustive: never = tag;
              void _exhaustive;
            }
          }
        }
        // Arg-prompt history label refinement. Only fires for runs the
        // current TUI session launched with an `{{arg}}` value AND
        // succeeded. Looks up the def by actionId, then scans the
        // captured output with its `label_extract` regex (when set)
        // and (re)writes the history entry with the matched label.
        // No def, no regex, or no match → entry keeps the raw value;
        // graceful default.
        const argKey = `${run.slug}/${run.actionId}`;
        const argVal = pendingArgs.current.get(argKey);
        if (argVal !== undefined) {
          pendingArgs.current.delete(argKey);
          if (run.status === "succeeded") {
            const def =
              config.actions.find((d) => d.id === run.actionId) ??
              ALL_BUILTIN_ACTIONS.find((d) => d.id === run.actionId) ??
              null;
            const label = extractLabel(run.lines, def?.labelExtract ?? null);
            // Suppress redundant labels — when the regex captures the
            // same text the user typed (e.g. "Seeding company: <id>"
            // with no name resolution), recording it would render the
            // picker as `<id> · <id>`. Skip the update; the entry
            // keeps its `label: null` from launch-time and the picker
            // shows just the raw value.
            if (label && label !== argVal) {
              recordHistoryRun(run.actionId, argVal, label);
            }
          }
        }
      }
    });
  }, []);

  async function launchAction(
    slug: string,
    def: ActionDef | null,
    extras: string,
    arg?: string,
    launchOpts: LaunchActionOpts = {},
  ): Promise<LaunchOutcome> {
    const { rows, primaryHarness, toast, setFocus } = opts;
    // Automation launches (marked by `autoFireKeys`) suppress the
    // keystroke-style acks below: the engine already toasts its own
    // "auto <rule>: … — running <run>" dispatch line and narrates
    // declines/failures itself, so the direct toasts here would
    // clobber it in the single latest-wins slot (see the toast
    // contract in AGENTS.md — background paths toast via the logger).
    const manual = launchOpts.autoFireKeys === undefined;
    const ack: typeof toast = (...args) => {
      if (manual) toast(...args);
    };
    const row = rows.find((r) => r.wt.slug === slug);
    if (!row) {
      ack("worktree gone", theme.warn, 1500);
      return { launched: false, reason: "worktree gone" };
    }
    if (!def && !extras.trim()) {
      ack("prompt is empty", theme.warn, 1500);
      return { launched: false, reason: "prompt is empty" };
    }
    // Manager-target actions never touch the source worktree — they
    // send to the manager session and only READ the row for
    // template vars — so the destroy/busy gates below don't apply
    // (a needs-human fire happens exactly while the source session is
    // busy asking; gating on it would decline/retry forever).
    const isManagerTarget = def?.kind === "claude" && def.target === "manager";
    if (!isManagerTarget) {
      // Refuse if the worktree is being cleaned up (archived the instant a
      // destroy/clean dispatches, before the flock exists) or mid-destroy /
      // mid-init (flock held). The archived half matters: a clean/destroy
      // flips `row.archived` synchronously but the detached `_destroy`
      // child only grabs the flock a process-spawn later, so `lockStatus`
      // alone leaves a window where an action would launch into a directory
      // about to be `git worktree remove --force`d. `launchBlockedReason`
      // checks both — the same gate every session launch uses.
      const blocked = launchBlockedReason(row);
      if (blocked) {
        ack(`${slug} is ${blocked}`, theme.warn, 2000);
        return { launched: false, reason: `${slug} is ${blocked}` };
      }
      if (row.status.kind === StatusKind.Busy) {
        ack(`${slug} is busy`, theme.warn, 2000);
        return { launched: false, reason: `${slug} is busy` };
      }
    }
    if (def) {
      const avail = evaluateActionRequirements(def.requires, {
        slug,
        issueId: row.issueId,
        pr: row.pr,
        deployed: row.fields.deploy.data ?? false,
      });
      if (!avail.ok) {
        ack(`${def.name}: ${avail.reason}`, theme.warn, 2500);
        return { launched: false, reason: avail.reason };
      }
    }
    const baseVars = buildActionVars(row, actionSkillPrefix(def, primaryHarness));
    // `{{arg}}` substitution lives alongside the row-derived vars. The
    // value, when present, came from the action-arg picker; gets folded
    // in for both shell and claude actions (including session-target).
    const vars: ActionVars = arg ? { ...baseVars, arg } : baseVars;
    // Record the value used so the next picker open shows it at top.
    // Label is null here — the LABEL scan in the actionRegistry
    // subscriber refines it after the run finishes (if the script
    // emitted a marker line). Idempotent against re-runs of the same
    // value (LRU dedup).
    if (def && arg && def.id !== "__custom__") {
      recordHistoryRun(def.id, arg, null);
      pendingArgs.current.set(`${slug}/${def.id}`, arg);
    }
    // Session- and manager-target prompt actions bypass the headless
    // `-p` runner and deliver the prompt to a live harness session
    // (starting its tmux host detached if needed): the worktree's
    // primary F12 session for `session`, the singleton manager session — prefixed
    // `[re: <slug>]` so the subject is explicit — for `manager`.
    // Fire-and-forget: there's no run to track or focus, so we just log
    // progress to the activity pane. The cold-start path can take a few
    // seconds, hence the immediate "sending…" toast. One shared
    // delivery helper so the two targets can't drift.
    if (def && def.kind === "claude" && (def.target === "session" || def.target === "manager")) {
      const renderedPrompt = applyVars(def.prompt, vars);
      const trimmedExtras = applyVars(extras, vars).trim();
      const body = trimmedExtras
        ? `${renderedPrompt}\n\n${trimmedExtras}`
        : renderedPrompt;
      const target =
        def.target === "manager"
          ? {
              slug: MANAGER_SLOT.slug,
              cwd: MANAGER_SLOT.path,
              managedName: MANAGER_SLOT.claudeName,
              label: "manager",
              text: `[re: ${slug}] ${body}`,
            }
          : {
              slug,
              cwd: row.wt.path,
              managedName: null,
              label: `${getHarness(primaryHarness).label} session`,
              text: body,
            };
      if (def.target === "manager") ensureManagerClaudeName();
      const sessionLog = createLogger(slug);
      sessionLog.event.info(`${def.name} → ${target.label}`);
      ack(`sending ${def.name} to ${target.label}…`, theme.info, 2000);
      void sendSessionMessage({
        slug: target.slug,
        cwd: target.cwd,
        harnessId: primaryHarness,
        managedName: target.managedName,
        text: target.text,
      }).then(
        (res) => {
          if (res.ok && res.delivered === false) {
            // Delivery is verified against the target's own transcript,
            // for EVERY harness including Claude — a dispatch that
            // can't be verified needs attention because an automation
            // has no other witness.
            sessionLog.attention.warn(
              `${target.label} never received ${def.name} — attach and check its pane`,
            );
          } else if (res.ok) {
            // Toast: the "sending…" ack above has long expired by the
            // time a cold start finishes, and this may be an automation
            // dispatch with no keystroke to acknowledge.
            // `delivered: null` is UNCONFIRMABLE, not confirmed: a
            // slash command is recorded as an expanded command entry,
            // so there is no prompt text to match. Say so rather than
            // claiming a verified send — but on the event feed, not the
            // attention feed: it's the expected outcome for a command,
            // and interrupting a scan for it every time would be noise.
            sessionLog.event.ok(
              `${res.coldStarted ? `started ${target.label} and sent` : `sent`} ${def.name}${
                res.coldStarted ? "" : ` to ${target.label}`
              }${res.delivered === null ? " (a command's arrival can't be confirmed)" : ""}`,
              { toast: true },
            );
          } else {
            // Logger-toast (not ctx.toast): the failure lands after the
            // dispatch ack expired, and it must flash for automation
            // launches too — this is their only failure surface.
            sessionLog.event.err(`send failed: ${res.reason}`, { toast: true });
          }
        },
        // sendSessionMessage resolves {ok:false} for its own failures,
        // but the cross-process delivery lock can REJECT on timeout
        // (withAsyncFileLock) — unhandled, that's a process-level
        // rejection, not a logged miss.
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          sessionLog.event.err(`send failed: ${msg}`, { toast: true });
        },
      );
      return { launched: true };
    }
    const result = def
      ? await actionRegistry.start(
          def,
          slug,
          row.wt.path,
          extras,
          vars,
          primaryHarness,
          { autoFireKeys: launchOpts.autoFireKeys },
        )
      : await actionRegistry.startCustom(
          slug,
          row.wt.path,
          extras,
          vars,
          primaryHarness,
        );
    if (!result.ok) {
      ack(`action: ${result.reason}`, theme.err, 3000);
      return { launched: false, reason: result.reason };
    }
    // Clear this worktree's focus so the auto-rules surface the
    // just-launched action.
    setFocus(slug, { focused: null });
    ack(`launched ${result.run.actionName}`, theme.info, 2000);
    return { launched: true };
  }

  /**
   * Slot-scoped delivery — the launch path for the palettes' `fleet:
   * true` builtins and free-text messages, addressed to a session slot
   * (the `M` manager palette and the `<` / `>` / `\` slot palettes).
   * Unlike the row path above there is no subject worktree: no row
   * gates and no `[re: <slug>]` prefix. The builtin's own prompt still
   * renders through `applyVars` for the row-less vars (`{{today}}`);
   * the user's free text deliberately does NOT, since rendering it
   * would eat literal `{{…}}` they typed. Same fire-and-forget delivery
   * + logging contract otherwise.
   */
  async function launchSlotCommand(
    slotSlug: string,
    def: ActionDef | null,
    extras: string,
  ): Promise<LaunchOutcome> {
    const { primaryHarness, toast } = opts;
    const slot = SESSION_SLOTS.find((s) => s.slug === slotSlug);
    if (!slot) {
      toast(`unknown slot ${slotSlug}`, theme.warn, 2000);
      return { launched: false, reason: `unknown slot ${slotSlug}` };
    }
    const trimmedExtras = extras.trim();
    const prompt = def && def.kind === "claude" ? applyVars(def.prompt, {}) : "";
    const body = trimmedExtras
      ? prompt
        ? `${prompt}\n\n${trimmedExtras}`
        : trimmedExtras
      : prompt;
    if (!body) {
      toast("prompt is empty", theme.warn, 1500);
      return { launched: false, reason: "prompt is empty" };
    }
    if (slot.slug === MANAGER_SLUG) ensureManagerClaudeName();
    const label = def?.name ?? "custom message";
    const slotLog = createLogger(slot.slug);
    slotLog.event.info(`${label} → ${slot.label}`);
    toast(`sending ${label} to ${slot.label}…`, theme.info, 2000);
    void sendSessionMessage({
      slug: slot.slug,
      cwd: slot.path,
      harnessId: primaryHarness,
      managedName: slot.claudeName,
      text: body,
    }).then(
      (res) => {
        if (res.ok && res.delivered === false) {
          // See the row path above: an unverified briefing stays visible.
          slotLog.attention.warn(
            `${slot.label} never received ${label} — attach and check its pane`,
          );
        } else if (res.ok) {
          // Toast: the "sending…" ack above has long expired by the time
          // a cold start finishes.
          // `delivered: null` is unconfirmable, not confirmed — the
          // manager palette's `M m` (`/compact`) is exactly this case.
          slotLog.event.ok(
            `${
              res.coldStarted
                ? `started ${slot.label} and sent ${label}`
                : `sent ${label} to ${slot.label}`
            }${res.delivered === null ? " (a command's arrival can't be confirmed)" : ""}`,
            { toast: true },
          );
        } else {
          slotLog.event.err(`send failed: ${res.reason}`, { toast: true });
        }
      },
      // Same rejection leg as the row path above: a slot session is a
      // multi-writer singleton, so the delivery lock CAN time out.
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        slotLog.event.err(`send failed: ${msg}`, { toast: true });
      },
    );
    return { launched: true };
  }

  return { launchAction, launchSlotCommand };
}
