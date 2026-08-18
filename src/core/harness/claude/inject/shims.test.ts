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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { HARNESSES } from "../../registry.ts";
import { __testing } from "./shims.ts";

const { discoverBunExecutables, isBunCompiled, pruneShims, shimBody, LAUNCHER_SHIM, NEVER_SHIM } =
  __testing;

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

describe("shimBody", () => {
  /** Write a shim, run it, return {stdout, stderr, exitCode}. */
  function runShim(
    dir: string,
    name: string,
    cmd: string,
    realPath: string,
    opts: { argv?: string[]; path?: string; env?: Record<string, string> } = {},
  ) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, shimBody(cmd, realPath), { mode: 0o700 });
    chmodSync(file, 0o700);
    const res = Bun.spawnSync([file, ...(opts.argv ?? [])], {
      // Bounded on purpose: the failure this guards against is an
      // infinite exec loop, and an unbounded spawn would hang the suite
      // instead of failing it. A hang is not a test result.
      timeout: 15_000,
      env: {
        ...process.env,
        BUN_INSPECT: "ws+unix:///tmp/wt-shim-test.sock",
        ...(opts.path ? { PATH: opts.path } : {}),
        ...(opts.env ?? {}),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: res.stdout.toString().trim(),
      stderr: res.stderr.toString().trim(),
      exitCode: res.exitCode,
    };
  }

  test("strips BUN_INSPECT before exec'ing the baked binary", () => {
    const dir = join(tmpdir(), `wt-shimbody-${Date.now()}-a`);
    // printenv exits 1 when the name is unset — that IS the assertion.
    const r = runShim(dir, "printenv", "printenv", "/usr/bin/printenv", {
      argv: ["BUN_INSPECT"],
    });
    expect(r.stdout).toBe("");
    expect(r.exitCode).toBe(1);
  });

  // fnm puts pnpm/npx/yarn in a per-shell directory, so a baked path can
  // die while the command is perfectly installed. Shadowing a working
  // binary is worse than the leak the shim exists to stop.
  test("falls back to PATH when the baked path is gone", () => {
    const dir = join(tmpdir(), `wt-shimbody-${Date.now()}-b`);
    const r = runShim(dir, "printenv", "printenv", "/nonexistent/gone/printenv", {
      argv: ["HOME"],
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(process.env.HOME ?? "");
  });

  // The regression that actually bit: the shim dropped only the BAKED
  // shim dir from PATH, so a copy living anywhere else re-found itself
  // and exec'd forever. It drops $0's dirname too.
  test("cannot exec itself when its own directory is on PATH", () => {
    const dir = join(tmpdir(), `wt-shimbody-${Date.now()}-c`);
    const r = runShim(dir, "printenv", "printenv", "/nonexistent/gone/printenv", {
      argv: ["HOME"],
      path: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(process.env.HOME ?? "");
  });

  test("exits 127 with a diagnostic when the command is genuinely absent", () => {
    const dir = join(tmpdir(), `wt-shimbody-${Date.now()}-d`);
    const r = runShim(dir, "wt-no-such-tool", "wt-no-such-tool", "/nonexistent/x", {
      path: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    });
    expect(r.exitCode).toBe(127);
    expect(r.stderr).toContain("not found on PATH");
  });
});

describe("LAUNCHER_SHIM", () => {
  // Discovery is Mach-O `__BUN` detection, and a launcher is a node
  // script — it can never be found that way, which is exactly why the
  // gap went unnoticed: `pnpm exec supabase` prepends node_modules/.bin
  // and never consults the shimmed PATH entry at all.
  test("names launchers that resolve outside PATH, and no harness binary", () => {
    expect(LAUNCHER_SHIM).toContain("pnpm");
    expect(LAUNCHER_SHIM).toContain("npx");
    for (const cmd of NEVER_SHIM) expect(LAUNCHER_SHIM).not.toContain(cmd);
  });
});
