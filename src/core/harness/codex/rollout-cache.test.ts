import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as tailUtil from "../../tail-util.ts";
import { latestRolloutForCwd } from "./harness.ts";

const roots: string[] = [];
const CWD = "/test/rollout-cache";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wt-rollout-cache-"));
  roots.push(root);
  const day = join(root, "2026", "10", "06");
  mkdirSync(day, { recursive: true });
  return { root, day };
}

function metadata(source: string, id = "fixture") {
  return JSON.stringify({
    type: "session_meta",
    timestamp: "2026-10-06T12:00:00.000Z",
    payload: { id, cwd: CWD, originator: "wt", thread_source: source },
  });
}

describe("Codex rollout metadata cache", () => {
  test("warm scans do not reread valid excluded histories for each live slot", () => {
    const { root, day } = fixture();
    const padding = `${" ".repeat(64 * 1024)}\n`;
    for (let i = 0; i < 72; i++) {
      writeFileSync(join(day, `rollout-${i}.jsonl`), `${metadata(i < 8 ? "user" : "subagent", String(i))}\n${padding}`);
    }
    const read = spyOn(tailUtil, "readFileSlice");
    try {
      for (let slot = 0; slot < 6; slot++) {
        expect(latestRolloutForCwd(CWD, `slot-${slot}`, root)).not.toBeNull();
      }
      // Eight accepted and 64 excluded headers, each read once. Previously
      // the five warm scans reread all 64 excluded 64KiB prefixes: 392 reads.
      expect(read).toHaveBeenCalledTimes(72);
    } finally { read.mockRestore(); }
  });

  test("a changed excluded file is reread, then cached at its new size", () => {
    const { root, day } = fixture();
    const path = join(day, "rollout-excluded.jsonl");
    writeFileSync(path, `${metadata("subagent")}\n`);
    const read = spyOn(tailUtil, "readFileSlice");
    try {
      expect(latestRolloutForCwd(CWD, "slot", root)).toBeNull();
      appendFileSync(path, "{}\n");
      expect(latestRolloutForCwd(CWD, "slot", root)).toBeNull();
      expect(latestRolloutForCwd(CWD, "slot", root)).toBeNull();
      expect(read).toHaveBeenCalledTimes(2);
    } finally { read.mockRestore(); }
  });

  test("same-size replacement and truncation cannot hide a now-interactive session", () => {
    for (const kind of ["rewrite", "replace", "truncate"] as const) {
      const { root, day } = fixture();
      const path = join(day, "rollout-changing.jsonl");
      // Same-sized user/other metadata makes size alone insufficient.
      const excluded = `${metadata("exec")}\n`;
      const accepted = `${metadata("user")}\n`;
      expect(accepted.length).toBe(excluded.length);
      writeFileSync(path, excluded);
      expect(latestRolloutForCwd(CWD, "slot", root)).toBeNull();
      const before = statSync(path);
      if (kind === "replace") {
        const replacement = join(day, "replacement");
        writeFileSync(replacement, accepted);
        utimesSync(replacement, before.atime, before.mtime);
        renameSync(replacement, path);
      } else if (kind === "truncate") {
        writeFileSync(path, accepted.slice(0, 30));
        expect(latestRolloutForCwd(CWD, "slot", root)).toBeNull();
        appendFileSync(path, accepted.slice(30));
      } else {
        writeFileSync(path, accepted);
        utimesSync(path, before.atime, new Date(before.mtimeMs + 1000));
      }
      expect(latestRolloutForCwd(CWD, "slot", root)?.path).toBe(path);
    }
  });

  test("incomplete and unrecognized headers remain retryable", () => {
    for (const initial of [metadata("subagent"), '{"type":"session_meta","payload":', '{"type":"unknown"}\n']) {
      const { root, day } = fixture();
      const path = join(day, "rollout-incomplete.jsonl");
      writeFileSync(path, initial);
      const read = spyOn(tailUtil, "readFileSlice");
      try {
        expect(latestRolloutForCwd(CWD, "slot", root)).toBeNull();
        expect(latestRolloutForCwd(CWD, "slot", root)).toBeNull();
        expect(read).toHaveBeenCalledTimes(2);
        writeFileSync(path, `${metadata("user")}\n`);
        expect(latestRolloutForCwd(CWD, "slot", root)?.path).toBe(path);
      } finally { read.mockRestore(); }
    }
  });
});
