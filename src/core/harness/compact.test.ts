import { expect, test } from "bun:test";
import { Effect } from "effect";
import { compactMessages, compactPreparationReceived, sendCompactToRoute, submitPreparedCompact } from "./compact.ts";
import { listSessionsWithHarnessIds } from "../tmux/process.ts";
import { routeAgentTargets } from "./agent-routing.ts";
import { MANAGER_BUILTIN_ACTIONS, SLOT_BUILTIN_ACTIONS } from "../actions/builtins.ts";
import { applyVars } from "../actions/template.ts";

test("both palette compactions prepare Codex separately; Claude keeps inline instructions", () => {
  const defs = [...MANAGER_BUILTIN_ACTIONS, ...SLOT_BUILTIN_ACTIONS].filter(d => d.id.endsWith("-compact"));
  expect(defs).toHaveLength(2);
  for (const def of defs) {
    if (def.kind !== "claude") throw new Error("expected prompt action");
    const prompt = applyVars(def.prompt, { today: "Monday, September 14, 2026" });
    const messages = compactMessages("codex", prompt);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe("/compact");
    expect(messages[0]).toContain("Monday, September 14, 2026");
    expect(messages[0]).toContain("Do not compact yourself");
    if (def.id === "manager-compact") expect(messages[0]).toContain("$manager");
    expect(compactMessages("claude", prompt)).toEqual([prompt]);
    expect(compactMessages("opencode", prompt)).toEqual([prompt]);
  }
  expect(compactMessages("codex", "/compact")).toEqual(["/compact"]);
  expect(compactMessages("codex", "$manager")).toEqual(["$manager"]);
});

test("preparation receipt requires a new persisted user message, not queue ack or assistant prose", () => {
  const since = Date.parse("2026-09-14T12:00:00Z");
  const entry = (role: string, time: number, text = "[wt] preparation") => JSON.stringify({
    timestamp: new Date(time).toISOString(), type: "response_item",
    payload: { type: "message", role, content: [{ type: "input_text", text }] },
  });
  expect(compactPreparationReceived(entry("user", since), "preparation", since)).toBeTrue();
  expect(compactPreparationReceived(entry("assistant", since), "preparation", since)).toBeFalse();
  expect(compactPreparationReceived(entry("user", since - 1), "preparation", since)).toBeFalse();
  expect(compactPreparationReceived(entry("user", since, "other"), "preparation", since)).toBeFalse();
  expect(compactPreparationReceived('{"queued":true}\npartial', "preparation", since)).toBeFalse();
});

const route = routeAgentTargets([], new Set(["manager-codex"]), "claude")
  .find(r => r.target.slug === "manager")!;

for (const received of [true, false]) {
  test(`native command waits for preparation receipt (${received}), not queue acknowledgement`, async () => {
    const events: string[] = [];
    const result = await Effect.runPromise(sendCompactToRoute(route, "/compact Today is Monday. Re-run /manager.",
      (selected, text) => {
        expect(selected).toBe(route);
        events.push(text === "/compact" ? "command" : "preparation");
        return Effect.succeed({ ok: true as const, route, transport: "codex-app-server" as const,
          coldStarted: false, delivered: true, resent: false, queueState: "queued" as const });
      }, () => { events.push("receipt"); return Effect.succeed(received ? "thread-id" : null); },
      (selected, id) => {
        expect(selected).toBe(route);
        expect(id).toBe("thread-id");
        events.push("command");
        return Effect.succeed({ ok: true as const, route, transport: "terminal" as const,
          fallback: { kind: "command" as const, harnessId: "codex" as const },
          coldStarted: false, delivered: null, resent: false });
      }));
    expect(events).toEqual(received ? ["preparation", "receipt", "command"] : ["preparation", "receipt"]);
    expect(result.ok).toBe(received);
    if (!result.ok) expect(result.reason).toContain("NOT submitted");
  });
}

test("failed preparation never submits compact", async () => {
  const events: string[] = [];
  const result = await Effect.runPromise(sendCompactToRoute(route, "/compact focus",
    (_, text) => { events.push(text); return Effect.succeed({ ok: false as const, route, reason: "busy" }); },
    () => { throw new Error("must not check receipt"); }));
  expect(events).toHaveLength(1);
  expect(result).toMatchObject({ ok: false, reason: "busy" });
});

test("command execution stays unknown even after confirmed preparation", async () => {
  const result = await Effect.runPromise(sendCompactToRoute(route, "/compact focus",
    () => Effect.succeed({ ok: true as const, route, transport: "terminal" as const,
      fallback: { kind: "command" as const, harnessId: "codex" as const },
      coldStarted: false, delivered: null, resent: false }), () => Effect.succeed("thread-id"),
    () => Effect.succeed({ ok: true as const, route, transport: "terminal" as const,
      fallback: { kind: "command" as const, harnessId: "codex" as const },
      coldStarted: false, delivered: null, resent: false })));
  expect(result.ok && result.delivered).toBeNull();
});

test("the injection's final gate rejects a switched thread", async () => {
  const result = await Effect.runPromise(submitPreparedCompact(route, "prepared-thread",
    () => Effect.succeed({
      known: true, all: new Set(["manager-codex"]),
      harnessSessionIds: new Map([["manager-codex", "different-thread"]]),
    } as Effect.Success<ReturnType<typeof listSessionsWithHarnessIds>>),
    (target, _wait, gate) => gate.pipe(Effect.map(probe => {
      expect(target.text).toBe("/compact");
      expect(probe).toMatchObject({ ready: false, reason: "prepared Codex thread no longer owns the slot" });
      return { ok: false as const, reason: probe.reason! };
    }), Effect.catch(error => Effect.succeed({ ok: false as const, reason: error.message })))));
  expect(result).toMatchObject({ ok: false, reason: "prepared Codex thread no longer owns the slot" });
});
