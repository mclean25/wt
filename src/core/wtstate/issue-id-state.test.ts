/**
 * The tracker-id override's THREE states, round-tripped through a real
 * `state.json`.
 *
 * The distinction is only visible on a slug that carries an id, and the
 * half that broke silently was the PARSE: it required a non-empty
 * string, so an asserted none round-tripped to nothing with every
 * in-memory check still green, and "this worktree has no ticket"
 * quietly became "whatever the slug parses to".
 *
 * Subprocess + generated `WT_CONFIG`, since config loads once at module
 * init and `cache_db` (via `cache_root`) is what isolates the state file.
 */
import { afterAll, expect, test } from "bun:test";

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const WTSTATE_MOD = JSON.stringify(
  pathToFileURL(join(import.meta.dir, "..", "wtstate.ts")).href,
);

function inSandbox(script: string): string {
  const root = mkdtempSync(join(tmpdir(), "wt-iid-"));
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

test("an asserted none survives the state file, distinct from absent", () => {
  // The parse used to require a non-empty string, so an asserted none
  // round-tripped to nothing with every in-memory test still green —
  // and "no ticket" silently became "whatever the slug parses to".
  const out = inSandbox(`
    const m = await import(${WTSTATE_MOD});
    const { resolveIssueId } = await import(${JSON.stringify(
      pathToFileURL(join(import.meta.dir, "..", "issue-tracker.ts")).href,
    )});
    m.setSlugIssueId("coz-2101-connector", "");
    m.setSlugIssueId("coz-2102-other", "COZ-9");
    const s = m.readWtState().slugs;
    console.log(JSON.stringify({
      none: resolveIssueId("coz-2101-connector", s["coz-2101-connector"].issueId),
      override: resolveIssueId("coz-2102-other", s["coz-2102-other"].issueId),
      absent: resolveIssueId("coz-2103-third", s["coz-2103-third"]?.issueId),
    }));
  `);
  expect(JSON.parse(out.trim())).toEqual({
    none: null,
    override: "COZ-9",
    absent: "COZ-2103",
  });
});

test("--clear-id after an asserted none restores the slug's id", () => {
  const out = inSandbox(`
    const m = await import(${WTSTATE_MOD});
    const { resolveIssueId } = await import(${JSON.stringify(
      pathToFileURL(join(import.meta.dir, "..", "issue-tracker.ts")).href,
    )});
    m.setSlugIssueId("coz-2101-connector", "");
    m.setSlugIssueId("coz-2101-connector", null);
    const stored = m.readWtState().slugs["coz-2101-connector"]?.issueId;
    console.log(JSON.stringify({ back: resolveIssueId("coz-2101-connector", stored) }));
  `);
  expect(JSON.parse(out.trim())).toEqual({ back: "COZ-2101" });
});
