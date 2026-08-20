/**
 * `setSlugWorkStatus` round-tripped through a real `state.json`, because
 * the bug this pins was invisible to every in-memory check: the guard
 * dropped the write, and the CLI reported the record it had built in
 * memory, so stdout confirmed a store that never happened. Only reading
 * the row back afterwards showed it — which nobody does after a tick.
 *
 * Subprocess + generated `WT_CONFIG`, since config loads once at module
 * init and `cache_root` (from `cache_db`) is what isolates the state file.
 */
import { expect, test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll } from "bun:test";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const WTSTATE_MOD = JSON.stringify(
  pathToFileURL(join(import.meta.dir, "..", "wtstate.ts")).href,
);

/** Run `script` against a throwaway wt config; returns its stdout. */
function inSandbox(script: string): string {
  const root = mkdtempSync(join(tmpdir(), "wt-wsw-"));
  dirs.push(root);
  const cfg = join(root, "config.toml");
  writeFileSync(
    cfg,
    `
[paths]
main_clone = ${JSON.stringify(join(root, "main"))}
worktree_root = ${JSON.stringify(join(root, "wts"))}
cache_db = ${JSON.stringify(join(root, "cache", "cache.sqlite"))}

[branch]
prefix = "t"
`,
  );
  const r = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: { ...process.env, WT_CONFIG: cfg },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(r.exitCode, r.stderr.toString()).toBe(0);
  return r.stdout.toString();
}

test("amending ONLY the post-merge steps is stored, and says it stored", () => {
  const out = inSandbox(`
    const m = await import(${WTSTATE_MOD});
    const at = "2026-08-20T12:00:00.000Z";
    const first = { state: "ready", risk: "low", at, verifyAfterMerge: "old steps" };
    m.setSlugWorkStatus("s", first);
    // Everything the drifted guard compared is IDENTICAL here; only the
    // field it never learned about differs.
    const wrote = m.setSlugWorkStatus("s", { ...first, verifyAfterMerge: "new steps" });
    const stored = m.readWtState().slugs["s"].work;
    console.log(JSON.stringify({ wrote, steps: stored.verifyAfterMerge, at: stored.at }));
  `);
  expect(JSON.parse(out.trim())).toEqual({
    wrote: true,
    steps: "new steps",
    // An amend re-judges an existing assertion, so the timestamp stays.
    at: "2026-08-20T12:00:00.000Z",
  });
});

test("amending ONLY the gate is stored too — same drift, same fix", () => {
  const out = inSandbox(`
    const m = await import(${WTSTATE_MOD});
    const at = "2026-08-20T12:00:00.000Z";
    const first = { state: "ready", risk: "low", at, blockedOn: "mobile release" };
    m.setSlugWorkStatus("s", first);
    const wrote = m.setSlugWorkStatus("s", { ...first, blockedOn: "upstream branch" });
    console.log(JSON.stringify({ wrote, gate: m.readWtState().slugs["s"].work.blockedOn }));
  `);
  expect(JSON.parse(out.trim())).toEqual({ wrote: true, gate: "upstream branch" });
});

test("a genuinely identical re-assert still no-ops, and SAYS it did not write", () => {
  // The other half: agents re-assert freely, and every accepted repeat
  // bumps `at`, which re-narrates and re-toasts the same news in every
  // watching TUI. The return value is what lets a caller tell the two
  // apart instead of reporting its own argument back as fact.
  const out = inSandbox(`
    const m = await import(${WTSTATE_MOD});
    const rec = { state: "working", at: "2026-08-20T12:00:00.000Z" };
    m.setSlugWorkStatus("s", rec);
    const wrote = m.setSlugWorkStatus("s", { ...rec, at: "2026-08-20T13:00:00.000Z" });
    console.log(JSON.stringify({ wrote, at: m.readWtState().slugs["s"].work.at }));
  `);
  expect(JSON.parse(out.trim())).toEqual({
    wrote: false,
    at: "2026-08-20T12:00:00.000Z",
  });
});
