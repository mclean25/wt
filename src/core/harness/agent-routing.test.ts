import { describe, expect, test } from "bun:test";

import type { SessionSlot } from "../session-slots.ts";
import type { Worktree } from "../types.ts";
import { Effect } from "effect";

import {
  agentTargets,
  findAgentTarget,
  routeAgentTargets,
  sendAgentMessageToRoute,
} from "./agent-routing.ts";

const worktree = (slug: string, branch = `michael/${slug}`): Worktree => ({
  slug,
  branch,
  path: `/worktrees/${slug}`,
  stage: slug,
  isMain: false,
});

const slot = (slug: string, path: string, claudeName: string | null = null): SessionSlot => ({
  slug,
  path,
  claudeName,
  label: slug,
  key: "x",
  paletteKey: "X",
});

describe("agent target address book", () => {
  const targets = agentTargets(
    [worktree("ordinary", "michael/ordinary")],
    [slot("wt", "/src/wt"), slot("main", "/repo"), slot("manager", "/repo", "manager")],
  );

  test("resolves worktree slugs and branch aliases", () => {
    expect(findAgentTarget("ordinary", targets)).toMatchObject({
      kind: "worktree",
      cwd: "/worktrees/ordinary",
    });
    expect(findAgentTarget("michael/ordinary", targets)?.slug).toBe("ordinary");
  });

  test("resolves special sessions from the same address book", () => {
    expect(findAgentTarget("wt", targets)).toMatchObject({ kind: "special", cwd: "/src/wt" });
    expect(findAgentTarget("main", targets)).toMatchObject({ kind: "special", cwd: "/repo" });
  });

  test("keeps main and manager distinct despite a shared cwd", () => {
    expect(findAgentTarget("main", targets)).toMatchObject({
      slug: "main",
      managedName: null,
    });
    expect(findAgentTarget("manager", targets)).toMatchObject({
      slug: "manager",
      managedName: "manager",
    });
  });

  test("unknown names do not become worktree-only errors", () => {
    expect(findAgentTarget("missing", targets)).toBeNull();
  });

  test("inventory never advertises a worktree shadowed by a special slug", () => {
    const collisions = agentTargets(
      [worktree("wt"), worktree("ordinary")],
      [slot("wt", "/src/wt")],
    );
    expect(collisions.map((target) => `${target.kind}:${target.slug}`)).toEqual([
      "special:wt",
      "worktree:ordinary",
    ]);
  });

  test("inventory and send share active, primary-fallback, and multiple-live selection", () => {
    const routes = routeAgentTargets(
      [worktree("ordinary")],
      new Set(["wt-codex", "ordinary", "ordinary-codex"]),
      "codex",
      [slot("wt", "/src/wt")],
    );
    expect(routes.map((route) => ({
      target: route.target.slug,
      selected: route.choice.harnessId,
      source: route.choice.source,
      live: route.choice.liveHarnesses,
    }))).toEqual([
      { target: "wt", selected: "codex", source: "live", live: ["codex"] },
      { target: "ordinary", selected: "codex", source: "live", live: ["claude", "codex"] },
    ]);
  });

  test("an inaccessible registry remains unavailable for every addressable target", () => {
    const routes = routeAgentTargets(
      [worktree("ordinary")],
      null,
      "codex",
      [slot("wt", "/src/wt")],
    );
    expect(routes.every((route) =>
      route.choice.source === "unavailable" && route.choice.harnessId === null
    )).toBeTrue();
  });

  test("delivery receives the selected live harness and exact special identity", async () => {
    const route = routeAgentTargets(
      [],
      new Set(["manager-codex"]),
      "claude",
      [slot("manager", "/repo", "manager")],
    )[0]!;
    const seen: unknown[] = [];
    const result = await Effect.runPromise(sendAgentMessageToRoute(
      route,
      "hello",
      (target) => {
        seen.push(target);
        return Effect.succeed({
          ok: true as const,
          transport: "codex-app-server" as const,
          coldStarted: false,
          delivered: true,
          resent: false,
          queueState: "queued" as const,
        });
      },
    ));
    expect(seen).toEqual([{
      slug: "manager",
      cwd: "/repo",
      harnessId: "codex",
      managedName: "manager",
      text: "hello",
    }]);
    expect(result).toMatchObject({ ok: true, route, queueState: "queued" });
  });

  test("no live harness cold-starts only the configured primary", async () => {
    const route = routeAgentTargets(
      [worktree("ordinary")],
      new Set(),
      "opencode",
      [],
    )[0]!;
    let selected = "";
    const result = await Effect.runPromise(sendAgentMessageToRoute(
      route,
      "hello",
      (target) => {
        selected = target.harnessId;
        return Effect.succeed({
          ok: true as const,
          transport: "terminal" as const,
          fallback: { kind: "unsupported" as const, harnessId: "opencode" as const },
          coldStarted: true,
          delivered: true,
          resent: false,
        });
      },
    ));
    expect(selected).toBe("opencode");
    expect(result).toMatchObject({ ok: true, coldStarted: true });
  });
});
