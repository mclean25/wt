import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startActionTail, watchDoneSentinel } from "./tail.ts";

const dirs: string[] = [];

function runDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-action-tail-effect-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("action tail lifecycle", () => {
  test("close is idempotent and performs the final delta read exactly once", () => {
    const dir = runDir();
    writeFileSync(join(dir, "stream.log"), "");
    writeFileSync(join(dir, "stderr.log"), "");
    const lines: string[] = [];
    const tail = startActionTail({ runDir: dir, seed: false, onLine: (line) => lines.push(line.text) });

    appendFileSync(join(dir, "stream.log"), "last line\n");
    tail.close();
    tail.close();

    expect(lines).toEqual(["last line"]);
  });

  test("closing a done watcher prevents a later sentinel callback", async () => {
    const dir = runDir();
    mkdirSync(dir, { recursive: true });
    const seen: number[] = [];
    const watcher = watchDoneSentinel({ runDir: dir, onDone: (done) => seen.push(done.exitCode) });
    watcher.close();
    watcher.close();
    writeFileSync(join(dir, "done.json"), JSON.stringify({ exitCode: 0 }));
    await Bun.sleep(600);
    expect(seen).toEqual([]);
  });

  test("a throwing done callback cannot escape or fire twice", () => {
    const dir = runDir();
    writeFileSync(join(dir, "done.json"), JSON.stringify({ exitCode: 7 }));
    let calls = 0;
    const watcher = watchDoneSentinel({
      runDir: dir,
      onDone: () => {
        calls++;
        throw new Error("consumer failed");
      },
    });
    watcher.close();
    watcher.close();
    expect(calls).toBe(1);
  });
});
