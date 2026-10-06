import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { trackedTmpDirs } from "../test-fixtures.ts";

const { tmp } = trackedTmpDirs();

type Observation = { argv: string[]; cwd: string; nice: number; background: number | null };
type Scenario = "remove" | "stale" | "rollback";

async function collect(input: {
  hidden?: string[];
  gcExit?: number;
  scenario?: Scenario;
} = {}) {
  const root = tmp("wt-rift-gc-");
  const main = join(root, "main clone");
  const path = join(root, "checkout ; $ literal");
  const bin = join(root, "bin with spaces");
  const observations = join(root, "observations.jsonl");
  mkdirSync(main);
  mkdirSync(bin);
  writeFileSync(join(main, ".rift"), "fixture\n");
  // Query the actual child policy, not merely the requested command line.
  // PRIO_DARWIN_PROCESS is 4 in Darwin's sys/resource.h; getpriority returns
  // whether the process has background policy. No host process is modified.
  const priority = `
    import { getPriority } from "node:os";
    async function priority() {
      let background = null;
      if (process.platform === "darwin") {
        const { dlopen, FFIType } = await import("bun:ffi");
        const lib = dlopen("/usr/lib/libSystem.B.dylib", {
          getpriority: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        });
        background = lib.symbols.getpriority(4, 0);
        lib.close();
      }
      return { nice: getPriority(), background };
    }
  `;
  const scenario = input.scenario ?? "remove";
  writeFileSync(join(bin, "rift"), `#!/usr/bin/env bun
    import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
    ${priority}
    const argv = process.argv.slice(2);
    appendFileSync(${JSON.stringify(observations)}, JSON.stringify({
      argv, cwd: process.cwd(), ...await priority(),
    }) + "\\n");
    if (argv[0] === "gc") {
      // Completion must be observed before the backend returns.
      await Bun.sleep(25);
      writeFileSync(${JSON.stringify(join(root, "gc-completed"))}, "done");
      if (${input.gcExit ?? 0}) process.stderr.write("fixture GC failure\\n");
      process.exit(${input.gcExit ?? 0});
    }
    if (argv[0] === "create") {
      if (${JSON.stringify(scenario)} === "stale") {
        const retried = existsSync(${JSON.stringify(join(root, "gc-completed"))});
        console.error(retried ? "fixture retry failed" : "UNIQUE constraint failed: rift.path");
        process.exit(1);
      }
      mkdirSync(${JSON.stringify(path)});
      console.log(${JSON.stringify(path)});
    }
  `);
  chmodSync(join(bin, "rift"), 0o755);
  const config = join(root, "config.toml");
  writeFileSync(config, `
[paths]
main_clone = ${JSON.stringify(main)}
worktree_root = ${JSON.stringify(root)}
log_dir = ${JSON.stringify(join(root, "logs"))}
lock_dir = ${JSON.stringify(join(root, "locks"))}
cache_db = ${JSON.stringify(join(root, "cache.sqlite"))}
state_db = ${JSON.stringify(join(root, "state.sqlite"))}
[branch]
prefix = "test"
base = "main"
`);
  const url = (relative: string) => JSON.stringify(pathToFileURL(join(import.meta.dir, relative)).href);
  const child = Bun.spawn(["bun", "-e", `
    ${priority}
    import { existsSync } from "node:fs";
    import { Effect } from ${url("../../../node_modules/effect/dist/index.js")};
    const originalWhich = Bun.which;
    const hidden = new Set(${JSON.stringify(input.hidden ?? [])});
    Bun.which = (name, options) => hidden.has(name) ? null : originalWhich(name, options);
    const { createRiftWorktree, removeRiftWorktree } = await import(${url("rift.ts")});
    const baseline = await priority();
    const logs = [];
    const args = ${JSON.stringify({ path, mainClone: main, force: true, branch: "test/new", slug: "copy", baseRef: null })};
    args.onLog = line => logs.push(line);
    const operation = ${JSON.stringify(scenario)} === "remove" ? removeRiftWorktree(args) : createRiftWorktree(args);
    const result = await Effect.runPromise(operation.pipe(Effect.match({
      onFailure: error => ({ error: error.message, operation: error.operation }),
      onSuccess: value => value,
    })));
    console.log(JSON.stringify({ baseline, logs, result,
      completed: existsSync(${JSON.stringify(join(root, "gc-completed"))}),
    }));
  `], {
    cwd: root,
    env: {
      ...process.env,
      WT_CONFIG: config,
      WT_REPO_CONFIG: config,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exit, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ]);
  expect(exit, stderr).toBe(0);
  const result = JSON.parse(stdout.trim()) as {
    baseline: Pick<Observation, "nice" | "background">;
    logs: string[];
    result: { ok?: boolean; error?: string; operation?: string };
    completed: boolean;
  };
  const calls = readFileSync(observations, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Observation);
  return { ...result, calls, main, path };
}

function expectPriority(f: Awaited<ReturnType<typeof collect>>, hidden: string[] = []) {
  const gc = f.calls.find((call) => call.argv[0] === "gc")!;
  const nice = !hidden.includes("nice") && Bun.which("nice");
  expect(gc.nice).toBe(nice ? Math.min(process.platform === "darwin" ? 20 : 19, f.baseline.nice + 10) : f.baseline.nice);
  if (process.platform === "darwin") {
    const taskpolicy = !hidden.includes("taskpolicy") && Bun.which("taskpolicy", {
      PATH: `${process.env.PATH ?? ""}:/usr/sbin`,
    });
    expect(gc.background).toBe(taskpolicy ? 1 : f.baseline.background);
  }
}

test("Rift reclamation lowers the real child priority, preserves argv, and waits for cleanup", async () => {
  const f = await collect();
  expect(f.calls.map((call) => call.argv)).toEqual([["remove", "--force", f.path], ["gc"]]);
  expect(f.calls.every((call) => call.cwd === realpathSync(f.main))).toBe(true);
  expectPriority(f);
  expect(f.calls[0]!.nice).toBe(f.baseline.nice);
  expect(f.completed).toBe(true);
  expect(f.result).toEqual({ ok: true });
  expect(f.logs).toContain("rift gc (reclaiming trashed files)");
  expect(f.logs.some((line) => /^rift gc finished in /.test(line))).toBe(true);
}, 10_000);

for (const hidden of [["nice"], ["taskpolicy"], ["nice", "taskpolicy"]]) {
  test(`Rift reclamation tolerates missing ${hidden.join(" and ")}`, async () => {
    const f = await collect({ hidden });
    expectPriority(f, hidden);
    expect(f.completed).toBe(true);
    expect(f.result).toEqual({ ok: true });
  }, 10_000);
}

test("nonzero GC warns without turning a successful removal into failure", async () => {
  const f = await collect({ gcExit: 7 });
  expect(f.result).toEqual({ ok: true });
  expect(f.logs).toContain("rift gc warning: fixture GC failure");
  expect(f.logs.some((line) => line.endsWith(" (cleanup failed)"))).toBe(true);
}, 10_000);

test("stale-registry retry waits for lowered-priority GC even when it exits nonzero", async () => {
  const f = await collect({ scenario: "stale", gcExit: 7 });
  expect(f.calls.map((call) => call.argv[0])).toEqual(["create", "gc", "create"]);
  expectPriority(f);
  expect(f.result.operation).toBe("create");
  expect(f.result.error).toContain("fixture retry failed");
}, 10_000);

test("failed materialization retains its error after lowered-priority rollback GC fails", async () => {
  const f = await collect({ scenario: "rollback", gcExit: 7 });
  expect(f.calls.map((call) => call.argv[0])).toEqual(["create", "remove", "gc"]);
  expectPriority(f);
  expect(f.completed).toBe(true);
  expect(f.result.operation).toBe("materialize");
  expect(f.result.error).toContain("could not refresh copied Git index");
}, 10_000);
