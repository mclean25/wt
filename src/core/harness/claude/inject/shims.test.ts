/**
 * Two failure modes are pinned here, and both cost the fleet its
 * transport once already.
 *
 * PATH resolves the DIRECTORY, not the wanted set, so the directory
 * being append-only on disk means a shim that should be gone keeps
 * being used by every session forever. That happened with `claude`.
 *
 * And `claude` is itself bun-compiled, so the discovery pass finds it
 * like any other — shimming it would strip `BUN_INSPECT` from the one
 * process wt sets it for. `NEVER_SHIM` is checked against the harness
 * registry here rather than by eye, because a future harness whose
 * binary is bun-compiled walks into the same trap silently.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HARNESSES } from "../../registry.ts";
import { __testing } from "./shims.ts";

const { discoverBunExecutables, isBunCompiled, pruneShims, NEVER_SHIM } = __testing;

/** Comfortably over the scan's size floor, without writing 9MB. */
const BIG = 9 * 1024 * 1024;

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "wt-shims-test-"));
}

/**
 * A stand-in for a `bun build --compile` binary: the `__BUN` segment
 * name in the header, then sparse padding past the size floor.
 */
function fakeExecutable(
  dir: string,
  name: string,
  opts: { bun?: boolean; big?: boolean; executable?: boolean } = {},
): void {
  const { bun = true, big = true, executable = true } = opts;
  const path = join(dir, name);
  writeFileSync(path, bun ? "\xcf\xfa\xed\xfe__BUN\x00__bun\x00" : "\xcf\xfa\xed\xfe__TEXT\x00");
  if (big) truncateSync(path, BIG);
  chmodSync(path, executable ? 0o755 : 0o644);
}

describe("discoverBunExecutables", () => {
  test("finds a bun-compiled binary and ignores everything else", () => {
    const dir = scratchDir();
    try {
      fakeExecutable(dir, "supabase");
      fakeExecutable(dir, "gh", { bun: false });
      // Small: a bun-compiled binary embeds the whole runtime, so
      // anything this size is something else wearing the marker.
      fakeExecutable(dir, "tiny", { big: false });
      fakeExecutable(dir, "notexec", { executable: false });
      const found = discoverBunExecutables(dir);
      expect([...found.keys()]).toEqual(["supabase"]);
      expect(found.get("supabase")).toBe(join(dir, "supabase"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("first match on PATH wins, even when it is not the bun one", () => {
    // The command that actually runs is the one PATH resolves. Shimming
    // a shadowed binary would put a wrapper in front of something no
    // one invokes, and leave the real one unwrapped.
    const first = scratchDir();
    const second = scratchDir();
    try {
      fakeExecutable(first, "supabase", { bun: false });
      fakeExecutable(second, "supabase");
      expect([...discoverBunExecutables(`${first}:${second}`).keys()]).toEqual([]);
      expect([...discoverBunExecutables(`${second}:${first}`).keys()]).toEqual(["supabase"]);
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  test("survives an unreadable or absent PATH entry", () => {
    // Runs on the spawn path; a stale PATH entry must not fail a launch.
    expect(() => discoverBunExecutables(join(tmpdir(), "wt-shims-absent-xyz"))).not.toThrow();
    expect(() => discoverBunExecutables("")).not.toThrow();
  });

  test("reads only the head, so a marker past it does not count", () => {
    const dir = scratchDir();
    try {
      const path = join(dir, "late");
      writeFileSync(
        path,
        Buffer.concat([Buffer.alloc(96 * 1024, 0x41), Buffer.from("__BUN\x00__bun\x00")]),
      );
      truncateSync(path, BIG);
      // The real segment name is in the Mach-O load commands at the
      // front; a program that merely mentions the string in its data is
      // not a bun binary, and scanning far enough to find out would mean
      // reading hundreds of MB per spawn.
      expect(isBunCompiled(path)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("NEVER_SHIM", () => {
  test("covers every harness binary wt launches sessions as", () => {
    for (const harness of HARNESSES) {
      const argv = harness.buildArgs({
        wtPath: "/tmp/wt-shims-test",
        slug: "probe",
        managedName: null,
        resumeSessionId: null,
      });
      const command = argv[0];
      expect(command).toBeDefined();
      expect(NEVER_SHIM as readonly string[]).toContain(command!);
    }
  });
});

describe("pruneShims", () => {
  test("removes a shim the wanted set no longer claims", () => {
    const dir = scratchDir();
    try {
      writeFileSync(join(dir, "claude"), "#!/bin/sh\nexec env -u BUN_INSPECT claude \"$@\"\n");
      writeFileSync(join(dir, "bun"), "#!/bin/sh\n");
      pruneShims(dir, new Set(["bun"]));
      expect(readdirSync(dir)).toEqual(["bun"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps every shim that is still wanted", () => {
    const dir = scratchDir();
    try {
      for (const cmd of ["bun", "supabase"]) writeFileSync(join(dir, cmd), "#!/bin/sh\n");
      pruneShims(dir, new Set(["bun", "supabase"]));
      expect(readdirSync(dir).sort()).toEqual(["bun", "supabase"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is a no-op on a directory that does not exist", () => {
    // Pruning runs on the spawn path and must never be able to fail a
    // session launch.
    expect(() =>
      pruneShims(join(tmpdir(), "wt-shims-test-absent-xyz"), new Set(["bun"])),
    ).not.toThrow();
  });
});
