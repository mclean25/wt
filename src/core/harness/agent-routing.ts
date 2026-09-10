import { Effect } from "effect";

import { SESSION_SLOTS, type SessionSlot } from "../session-slots.ts";
import { ensureManagerClaudeName, MANAGER_SLUG } from "../manager.ts";
import { dirSlug } from "../stage.ts";
import { probeSessionNames } from "../tmux/process.ts";
import type { Worktree } from "../types.ts";
import { listWorktrees, type WorktreeError } from "../worktree.ts";
import { chooseHarness, type HarnessChoice } from "./live-target.ts";
import { readPrimaryHarness } from "./primary.ts";
import type { HarnessId } from "./types.ts";
import {
  sendSessionMessage,
  type SessionMessagingError,
  type SessionMessageResult,
} from "./session-messaging.ts";

export type AgentTarget = {
  kind: "worktree" | "special";
  slug: string;
  branch: string | null;
  cwd: string;
  label: string;
  managedName: string | null;
};

export type AgentRoute = {
  target: AgentTarget;
  choice: HarnessChoice;
};

export type RoutedAgentMessageResult =
  | ({ route: AgentRoute } & SessionMessageResult)
  | { ok: false; reason: string; route: AgentRoute | null };

/** One authoritative address book shared by send and inventory. */
export function agentTargets(
  worktrees: readonly Worktree[],
  slots: readonly SessionSlot[] = SESSION_SLOTS,
): AgentTarget[] {
  const special = slots.map((slot): AgentTarget => ({
    kind: "special",
    slug: slot.slug,
    branch: null,
    cwd: slot.path,
    label: slot.label,
    managedName: slot.claudeName,
  }));
  const specialSlugs = new Set(special.map((target) => target.slug));
  const ordinary = worktrees
    .filter((worktree) => !worktree.isMain && !specialSlugs.has(worktree.slug))
    .map((worktree): AgentTarget => ({
      kind: "worktree",
      slug: worktree.slug,
      branch: worktree.branch,
      cwd: worktree.path,
      label: worktree.slug,
      managedName: null,
    }));
  return [...special, ...ordinary];
}

export function findAgentTarget(
  requested: string,
  targets: readonly AgentTarget[],
): AgentTarget | null {
  const special = targets.find(
    (target) => target.kind === "special" && target.slug === requested,
  );
  if (special) return special;
  const slug = requested.includes("/") ? dirSlug(requested) : requested;
  return targets.find(
    (target) =>
      target.kind === "worktree" &&
      (target.slug === slug || target.branch === requested),
  ) ?? null;
}

export function routeAgentTargets(
  worktrees: readonly Worktree[],
  names: ReadonlySet<string> | null,
  primary: HarnessId,
  slots: readonly SessionSlot[] = SESSION_SLOTS,
): AgentRoute[] {
  const targets = agentTargets(worktrees, slots);
  const knownSlugs = new Set(targets.map((target) => target.slug));
  return targets.map((target): AgentRoute => ({
    target,
    choice: chooseHarness(target.slug, names, knownSlugs, primary),
  }));
}

export const inspectAgentTargets = Effect.fn("inspectAgentTargets")(function* (
): Effect.fn.Return<AgentRoute[], WorktreeError> {
  const worktrees = yield* listWorktrees();
  const names = yield* probeSessionNames();
  const primary = readPrimaryHarness();
  return routeAgentTargets(worktrees, names, primary);
});

export const resolveAgentRoute = Effect.fn("resolveAgentRoute")(function* (
  requested: string,
): Effect.fn.Return<AgentRoute | null, WorktreeError> {
  const routes = yield* inspectAgentTargets();
  const target = findAgentTarget(requested, routes.map((route) => route.target));
  return target
    ? routes.find((route) => route.target === target) ?? null
    : null;
});

export const sendAgentMessageToRoute = Effect.fn("sendAgentMessageToRoute")(function* (
  route: AgentRoute,
  text: string,
  deliver: typeof sendSessionMessage = sendSessionMessage,
): Effect.fn.Return<RoutedAgentMessageResult, SessionMessagingError> {
  const harnessId = route.choice.harnessId;
  if (harnessId === null) {
    return {
      ok: false,
      reason: "could not inspect wt's tmux session registry; no harness was selected or started",
      route,
    };
  }
  if (route.target.slug === MANAGER_SLUG && harnessId === "claude") {
    ensureManagerClaudeName();
  }
  const result = yield* deliver({
    slug: route.target.slug,
    cwd: route.target.cwd,
    harnessId,
    managedName: route.target.managedName,
    text,
  });
  return { ...result, route };
});

/** Resolve, select, and deliver without exposing a harness choice to callers. */
export const sendAgentMessage = Effect.fn("sendAgentMessage")(function* (
  requested: string,
  text: string,
): Effect.fn.Return<RoutedAgentMessageResult, WorktreeError | SessionMessagingError> {
  const route = yield* resolveAgentRoute(requested);
  if (!route) return { ok: false, reason: `unknown agent target: ${requested}`, route: null };
  return yield* sendAgentMessageToRoute(route, text);
});
