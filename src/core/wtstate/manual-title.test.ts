import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll } from "bun:test";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const WTSTATE_MOD = JSON.stringify(pathToFileURL(join(import.meta.dir, "..", "wtstate.ts")).href);
const IO_MOD = JSON.stringify(pathToFileURL(join(import.meta.dir, "io.ts")).href);
const EFFECT_MOD = JSON.stringify(import.meta.resolve("effect"));

function inSandbox(script: string): string {
  const root = mkdtempSync(join(tmpdir(), "wt-manual-title-"));
  dirs.push(root);
  const config = join(root, "config.toml");
  writeFileSync(config, `
[paths]
main_clone = ${JSON.stringify(join(root, "main"))}
worktree_root = ${JSON.stringify(join(root, "wts"))}
cache_db = ${JSON.stringify(join(root, "cache", "cache.sqlite"))}
state_db = ${JSON.stringify(join(root, "state", "wt.sqlite"))}

[branch]
prefix = "t"
`);
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: root,
    env: { ...process.env, WT_CONFIG: config, WT_REPO_CONFIG: config },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return result.stdout.toString();
}

test("manual title writes are trimmed and revision CAS rejects delayed generation after same-text edit", () => {
  const out = inSandbox(`
    const m = await import(${WTSTATE_MOD});
    const { Effect } = await import(${EFFECT_MOD});
    const first = await Effect.runPromise(m.setSlugManualTitle("task", "  Pinned title  "));
    const sameTextEdit = await Effect.runPromise(m.setSlugManualTitle("task", "Pinned title", { expectedRevision: 1 }));
    const delayedGeneration = await Effect.runPromise(m.setSlugManualTitle("task", "Old generated title", { expectedRevision: 1 }));
    const freshGeneration = await Effect.runPromise(m.setSlugManualTitle("task", "Fresh generated title", { expectedRevision: 2 }));
    console.log(JSON.stringify({ first, sameTextEdit, delayedGeneration, freshGeneration, stored: m.readWtState().slugs.task }));
  `);
  expect(JSON.parse(out.trim())).toMatchObject({
    first: true,
    sameTextEdit: true,
    delayedGeneration: false,
    freshGeneration: true,
    stored: {
      manualTitle: "Fresh generated title",
      manualTitleRevision: 3,
      section: null,
      order: 0,
    },
  });
});

test("manual title requires nonblank text and compare-and-set checks absence", () => {
  const out = inSandbox(`
    const m = await import(${WTSTATE_MOD});
    const { Effect } = await import(${EFFECT_MOD});
    const stale = await Effect.runPromise(m.setSlugManualTitle("task", "Generated", { expectedRevision: 1 }));
    const blankError = await Effect.runPromise(m.setSlugManualTitle("task", "  ").pipe(
      Effect.match({ onFailure: error => ({ tag: error._tag, message: error.message }), onSuccess: () => null })
    ));
    const created = await Effect.runPromise(m.setSlugManualTitle("task", "Manual", { expectedRevision: 0 }));
    console.log(JSON.stringify({ stale, blankError, created, state: m.readWtState().slugs.task }));
  `);
  expect(JSON.parse(out.trim())).toMatchObject({
    stale: false,
    blankError: { tag: "EmptyManualTitle", message: "set title for task: manual title must not be empty" },
    created: true,
    state: { manualTitle: "Manual", manualTitleRevision: 1 },
  });
});

test("manual title updates preserve other slug fields and revision exhaustion is a typed failure without a write", () => {
  const out = inSandbox(`
    const m = await import(${WTSTATE_MOD});
    const io = await import(${IO_MOD});
    const { Effect } = await import(${EFFECT_MOD});
    m.setSlugBase("task", { branch: "parent", sha: "anchor" });
    m.setSlugDevPort("task", 12345);
    m.placeSlug("task", "Pinned", "bottom");
    await Effect.runPromise(m.setSlugManualTitle("task", "Original"));
    const before = m.readWtState();
    before.slugs.task.manualTitleRevision = Number.MAX_SAFE_INTEGER;
    io.writeWtState(before);
    const exhausted = await Effect.runPromise(m.setSlugManualTitle("task", "Replacement").pipe(
      Effect.match({ onFailure: error => ({ tag: error._tag, message: error.message }), onSuccess: () => null })
    ));
    console.log(JSON.stringify({ exhausted, stored: m.readWtState().slugs.task }));
  `);
  expect(JSON.parse(out.trim())).toMatchObject({
    exhausted: { tag: "ManualTitleRevisionExhausted", message: "set title for task: manual title revision exhausted" },
    stored: {
      manualTitle: "Original",
      manualTitleRevision: Number.MAX_SAFE_INTEGER,
      section: "Pinned",
      order: 0,
      baseBranch: "parent",
      baseSha: "anchor",
      devPort: 12345,
    },
  });
});

test("manual title filesystem failures use the expected error channel", () => {
  const out = inSandbox(`
    const m = await import(${WTSTATE_MOD});
    const { Effect } = await import(${EFFECT_MOD});
    const { writeFileSync } = await import("node:fs");
    writeFileSync("state", "blocks the database directory");
    const failure = await Effect.runPromise(m.setSlugManualTitle("task", "Pinned").pipe(
      Effect.match({ onFailure: error => ({ tag: error._tag, source: error.source, operation: error.operation }), onSuccess: () => null })
    ));
    console.log(JSON.stringify(failure));
  `);
  expect(JSON.parse(out.trim())).toEqual({
    tag: "OperationError",
    source: "manual title",
    operation: "save title for task",
  });
});
