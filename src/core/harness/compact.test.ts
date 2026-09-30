import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { compactCommand, sendCompactToRoute } from "./compact.ts";
import { routeAgentTargets } from "./agent-routing.ts";
import { MANAGER_BUILTIN_ACTIONS, SLOT_BUILTIN_ACTIONS } from "../actions/builtins.ts";
import { applyVars } from "../actions/template.ts";
import { typeAndSubmitCodexCompact } from "../tmux/inject.ts";

test("both palette compactions use one native Codex command; other harnesses keep focus", () => {
  const defs = [...MANAGER_BUILTIN_ACTIONS, ...SLOT_BUILTIN_ACTIONS].filter(d => d.id.endsWith("-compact"));
  expect(defs).toHaveLength(2);
  for (const def of defs) {
    if (def.kind !== "claude") throw new Error("expected prompt action");
    const prompt = applyVars(def.prompt, { today: "Tuesday, September 29, 2026" });
    expect(compactCommand("codex", prompt)).toBe("/compact");
    expect(compactCommand("claude", prompt)).toBe(prompt);
    expect(compactCommand("opencode", prompt)).toBe(prompt);
  }
  expect(compactCommand("codex", "/compact")).toBe("/compact");
  expect(compactCommand("codex", " /compact\nfocus")).toBe("/compact");
  expect(compactCommand("codex", "/compact-other focus")).toBe("/compact-other focus");
});

const route = routeAgentTargets([], new Set(["manager-codex"]), "claude")
  .find(r => r.target.slug === "manager")!;

test("manager sends exactly once with no preparation, receipt wait, or queue turn", async () => {
  const calls: string[] = [];
  const result = await Effect.runPromise(sendCompactToRoute(route, "/compact Today is Tuesday. Re-run /manager.",
    (selected, text) => {
      expect(selected).toBe(route);
      calls.push(text);
      return Effect.succeed({ ok: true as const, route, transport: "terminal" as const,
        fallback: { kind: "command" as const, harnessId: "codex" as const },
        coldStarted: false, delivered: null, resent: false });
    }));
  expect(calls).toEqual(["/compact"]);
  expect(result).toMatchObject({ ok: true, delivered: null, transport: "terminal" });
});

test("unsafe terminal failure is returned without another send", async () => {
  const calls: string[] = [];
  const result = await Effect.runPromise(sendCompactToRoute(route, "/compact focus",
    (_, text) => { calls.push(text); return Effect.succeed({ ok: false as const, route, reason: "draft in composer" }); }));
  expect(calls).toEqual(["/compact"]);
  expect(result).toMatchObject({ ok: false, reason: "draft in composer" });
});

for (const failure of [null, 0, 1]) {
  test(`tmux compact uses literal typing and one Enter; never retries failure ${failure}`, async () => {
    const commands: string[][] = [];
    const result = await Effect.runPromise(Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(typeAndSubmitCodexCompact("manager-codex", args => {
        commands.push([...args]);
        const failed = commands.length - 1 === failure;
        return Effect.succeed({ code: failed ? 1 : 0, stderr: failed ? "tmux failed" : "", stdout: "" });
      }));
      yield* TestClock.adjust(500);
      return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())));
    expect(commands).toEqual(failure === 0
      ? [["send-keys", "-t", "=manager-codex:", "-l", "/compact"]]
      : [["send-keys", "-t", "=manager-codex:", "-l", "/compact"], ["send-keys", "-t", "=manager-codex:", "Enter"]]);
    expect(result.ok).toBe(failure === null);
  });
}
