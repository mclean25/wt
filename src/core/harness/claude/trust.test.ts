import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureTrustInFile } from "./trust.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(projects: Record<string, Record<string, unknown>>, extra = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-trust-"));
  dirs.push(dir);
  const p = join(dir, "claude.json");
  writeFileSync(p, JSON.stringify({ ...extra, projects }, null, 2));
  return p;
}

const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Record<string, any>;

describe("ensureTrustInFile", () => {
  test("trusts a path Claude has never seen", () => {
    const p = fixture({});
    expect(ensureTrustInFile(p, ["/wt/a"])).toEqual([]);
    expect(read(p).projects["/wt/a"].hasTrustDialogAccepted).toBe(true);
  });

  test("already trusted is a no-op — it does not rewrite the file", () => {
    // The load-bearing half of not being a clobber source itself: in
    // steady state this function must not touch a file Claude is using.
    const p = fixture({ "/wt/a": { hasTrustDialogAccepted: true } });
    const before = readFileSync(p, "utf8");
    expect(ensureTrustInFile(p, ["/wt/a"])).toEqual([]);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  test("preserves unrelated top-level state and sibling entries", () => {
    const p = fixture(
      { "/wt/a": { hasCompletedProjectOnboarding: true }, "/other": { history: [1, 2] } },
      { oauthAccount: { id: "x" }, mcpServers: { foo: {} } },
    );
    ensureTrustInFile(p, ["/wt/a"]);
    const d = read(p);
    expect(d.projects["/wt/a"].hasCompletedProjectOnboarding).toBe(true);
    expect(d.projects["/other"].history).toEqual([1, 2]);
    expect(d.oauthAccount).toEqual({ id: "x" });
    expect(d.mcpServers).toEqual({ foo: {} });
  });

  test("re-applies after a concurrent writer clobbers the write", () => {
    // The actual bug. A Claude process that read the file BEFORE our write
    // flushes its own snapshot back afterwards, so the trust key is gone
    // even though rename() succeeded and reported no error.
    const p = fixture({ "/wt/a": {} });
    const stale = readFileSync(p, "utf8");
    let flushes = 0;
    const lost = ensureTrustInFile(p, ["/wt/a"], {
      afterWrite: () => {
        if (flushes++ === 0) writeFileSync(p, stale);
      },
    });
    expect(flushes).toBe(2); // clobbered once, then the retry stuck
    expect(lost).toEqual([]);
    expect(read(p).projects["/wt/a"].hasTrustDialogAccepted).toBe(true);
  });

  test("reports what never stuck instead of claiming success", () => {
    // A writer that wins every round. The old code logged "trusted" off
    // rename() alone, so the log said trusted eight times while the dialog
    // appeared three times and nothing connected the two.
    const p = fixture({ "/wt/a": {} });
    const stale = readFileSync(p, "utf8");
    let flushes = 0;
    const lost = ensureTrustInFile(p, ["/wt/a"], {
      afterWrite: () => {
        flushes++;
        writeFileSync(p, stale);
      },
    });
    expect(lost).toEqual(["/wt/a"]);
    expect(flushes).toBe(3); // bounded — it gives up rather than spinning
  });

  test("repairs every wanted path in one write, not one per call", () => {
    // What converts a fan-out from decaying to converging: one stale flush
    // wipes all of wt's trust keys, so the next spawn has to heal the
    // siblings too rather than only its own worktree.
    const p = fixture({ "/wt/a": {}, "/wt/b": {}, "/wt/c": {} });
    expect(ensureTrustInFile(p, ["/wt/a", "/wt/b", "/wt/c"])).toEqual([]);
    const d = read(p);
    for (const s of ["a", "b", "c"]) {
      expect(d.projects[`/wt/${s}`].hasTrustDialogAccepted).toBe(true);
    }
  });

  test("the backup is the snapshot being REPLACED", () => {
    // copyFileSync ran after the read, so a write landing in between made
    // .bak newer than the state it was meant to preserve.
    const p = fixture({ "/wt/a": {} });
    const before = readFileSync(p, "utf8");
    ensureTrustInFile(p, ["/wt/a"]);
    expect(readFileSync(`${p}.bak`, "utf8")).toBe(before);
  });
});
