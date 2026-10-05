import { expect, spyOn, test } from "bun:test";
import { Effect } from "effect";

import { getHarness } from "../harness/index.ts";
import * as startup from "../harness/codex/startup.ts";
import * as tmuxConfig from "./config.ts";
import * as tmuxProcess from "./process.ts";
import { startHarnessSessionDetached } from "./lifecycle.ts";

test("an existing detached Codex slot is adopted without startup or discovery work", async () => {
  const inventory = spyOn(tmuxProcess, "probeSessionNames").mockReturnValue(Effect.succeed(new Set(["startup-proof-codex"])));
  const ready = spyOn(startup, "waitForCodexStartup");
  const discover = spyOn(getHarness("codex"), "discoverSessions");
  try {
    expect(await Effect.runPromise(startHarnessSessionDetached("startup-proof", "/unused", "codex")))
      .toEqual({ ok: true, adopted: true });
    expect(ready).not.toHaveBeenCalled();
    expect(discover).not.toHaveBeenCalled();
  } finally { inventory.mockRestore(); ready.mockRestore(); discover.mockRestore(); }
});

test("a detached cold start prepares trust before readiness and never spawns after its failure", async () => {
  const calls: string[] = [];
  const harness = getHarness("codex");
  const inventory = spyOn(tmuxProcess, "probeSessionNames").mockReturnValue(Effect.succeed(new Set()));
  const config = spyOn(tmuxConfig, "ensureConfig").mockReturnValue("/unused/tmux.conf");
  const discover = spyOn(harness, "discoverSessions").mockResolvedValue([]);
  const trust = spyOn(harness, "ensureTrusted").mockImplementation(() => Effect.sync(() => { calls.push("trust"); }));
  const ready = spyOn(startup, "waitForCodexStartup").mockImplementation(() => Effect.sync(() => { calls.push("readiness"); }).pipe(
    Effect.andThen(Effect.fail(new startup.CodexStartupReadinessError({ detail: "readiness timed out" }))),
  ));
  const spawn = spyOn(Bun, "spawn");
  try {
    expect(await Effect.runPromise(startHarnessSessionDetached("startup-proof", "/unused", "codex")))
      .toEqual({ ok: false, reason: "readiness timed out" });
    expect(calls).toEqual(["trust", "readiness"]);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    inventory.mockRestore(); config.mockRestore(); discover.mockRestore(); trust.mockRestore(); ready.mockRestore(); spawn.mockRestore();
  }
});
