/**
 * The shim directory is resolved by PATH, which reads the DIRECTORY —
 * not the `SHIMMED` list. So the list being append-only on disk is a
 * live failure mode rather than untidiness: a shim dropped from the
 * source keeps being used by every session forever. It happened, with
 * `claude`, and cost the whole fleet its inspector transport for a day.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { __testing } from "./shims.ts";

const { pruneUnknownShims, SHIMMED } = __testing;

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "wt-shims-test-"));
}

describe("pruneUnknownShims", () => {
  test("removes a shim that is no longer in SHIMMED", () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, "claude"), "#!/bin/sh\nexec env -u BUN_INSPECT claude \"$@\"\n");
      for (const cmd of SHIMMED) writeFileSync(join(dir, cmd), "#!/bin/sh\n");
      pruneUnknownShims(dir);
      expect(readdirSync(dir).sort()).toEqual([...SHIMMED].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps every shim that is still in SHIMMED", () => {
    const dir = scratchDir();
    try {
      for (const cmd of SHIMMED) writeFileSync(join(dir, cmd), "#!/bin/sh\n");
      pruneUnknownShims(dir);
      for (const cmd of SHIMMED) expect(readdirSync(dir)).toContain(cmd);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op on a directory that does not exist", () => {
    // Pruning runs on the spawn path and must never be able to fail a
    // session launch.
    expect(() => pruneUnknownShims(join(tmpdir(), "wt-shims-test-absent-xyz"))).not.toThrow();
  });
});
