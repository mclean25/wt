/**
 * The reaper KILLS processes based on parsed lsof output and a path
 * check, unattended, during every destroy. A parser that misreads a
 * pid or a path check that overreaches kills someone else's process —
 * so the filters are pinned here, plus one live end-to-end reap
 * against a real listener.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isUnderPath, parseCwdMap, parseListeners, reapWorktreeListeners } from "./reaper.ts";

describe("parseListeners", () => {
  test("groups fields into one record per pid, deduping ports", () => {
    const out = [
      "p819",
      "cnode",
      "n*:4199",
      "n127.0.0.1:4199",
      "p23110",
      "cbun",
      "n[::1]:8103",
      "",
    ].join("\n");
    expect(parseListeners(out)).toEqual([
      { pid: 819, command: "node", ports: [4199] },
      { pid: 23110, command: "bun", ports: [8103] },
    ]);
  });

  test("a pid listed twice (two sockets, separate blocks) stays one record", () => {
    const out = ["p819", "cnode", "n*:4199", "p819", "cnode", "n*:4200"].join("\n");
    expect(parseListeners(out)).toEqual([{ pid: 819, command: "node", ports: [4199, 4200] }]);
  });

  test("garbage pid lines are dropped, not misparsed", () => {
    expect(parseListeners("pnope\ncnode\nn*:80\n")).toEqual([]);
  });
});

describe("parseCwdMap", () => {
  test("maps pid to cwd path", () => {
    const out = ["p819", "fcwd", "n/Users/m/worktrees/eng-1", "p23110", "fcwd", "n/tmp"].join(
      "\n",
    );
    expect(parseCwdMap(out)).toEqual(
      new Map([
        [819, "/Users/m/worktrees/eng-1"],
        [23110, "/tmp"],
      ]),
    );
  });
});

describe("isUnderPath", () => {
  test("claims the root itself and children", () => {
    expect(isUnderPath("/wt/foo", "/wt/foo")).toBe(true);
    expect(isUnderPath("/wt/foo/apps/web", "/wt/foo")).toBe(true);
  });

  test("stops at the component boundary", () => {
    expect(isUnderPath("/wt/foobar", "/wt/foo")).toBe(false);
    expect(isUnderPath("/wt/eng-12", "/wt/eng-1")).toBe(false);
  });

  test("a trailing slash on the root changes nothing", () => {
    expect(isUnderPath("/wt/foo/sub", "/wt/foo/")).toBe(true);
    expect(isUnderPath("/wt/foobar", "/wt/foo/")).toBe(false);
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Live reap: a real listener cwd'd in a temp "worktree" dies; its twin
// cwd'd elsewhere survives. Skipped where lsof is unavailable.
describe.skipIf(!Bun.which("lsof"))("reapWorktreeListeners (live)", () => {
  function spawnListener(cwd: string): { proc: Bun.Subprocess; ready: Promise<void> } {
    // symlink-free path: lsof reports the resolved cwd, and the temp
    // dir on macOS lives under the /var -> /private/var symlink.
    const script = join(cwd, "listen.ts");
    writeFileSync(
      script,
      'const s = Bun.serve({ port: 0, fetch: () => new Response("ok") });\n' +
        "console.log(s.port);\n",
    );
    const proc = Bun.spawn(["bun", script], { cwd, stdout: "pipe", stderr: "ignore" });
    // stdout closes only at exit; readiness is the first byte (the port
    // print happens after Bun.serve is accepting).
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const ready = reader.read().then(() => reader.releaseLock());
    return { proc, ready };
  }

  test("kills the worktree's listener, spares the neighbour's", async () => {
    const wtDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-reap-target-")));
    const otherDir = realpathSync(mkdtempSync(join(tmpdir(), "wt-reap-bystander-")));
    tempDirs.push(wtDir, otherDir);

    const target = spawnListener(wtDir);
    const bystander = spawnListener(otherDir);
    await Promise.all([target.ready, bystander.ready]);

    try {
      const reaped = await reapWorktreeListeners(wtDir);
      expect(reaped.map((p) => p.pid)).toContain(target.proc.pid);
      expect(reaped.map((p) => p.pid)).not.toContain(bystander.proc.pid);

      // The target actually died; the bystander is still running.
      await target.proc.exited;
      expect(bystander.proc.killed).toBe(false);
    } finally {
      bystander.proc.kill();
      target.proc.kill();
    }
  }, 20_000);
});
