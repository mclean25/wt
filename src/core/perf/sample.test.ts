import { describe, expect, test } from "bun:test";

import { classifyProcess, isOrphanedWtInstance } from "./sample.ts";

/**
 * `classifyProcess` is the only pure, high-consequence piece of the
 * sampler: the overlay's whole "is it us?" claim rests on these buckets
 * being right, and every pattern matches anywhere on the command line,
 * so ordering bugs are easy to introduce and invisible at a glance.
 */
describe("classifyProcess", () => {
  test("real command lines land in the expected bucket", () => {
    const cases: Array<[string, string]> = [
      ["bun /Users/michael/.wt/bin/../src/main.ts", "wt"],
      ["claude --name primary --resume 0052342d-8dee", "harness"],
      ["/opt/homebrew/bin/codex", "harness"],
      ["node (vitest 7)", "test"],
      ["npm exec vitest run eslint-rules", "test"],
      ["cd supabase/functions && deno test --allow-env", "test"],
      ["node .../eslint/bin/eslint.js --config eslint.config.js", "build"],
      ["tsc --noEmit -p tsconfig.app.json", "build"],
      ["esbuild --service=0.21.5 --ping", "build"],
      ["tmux -L wt -f /Users/michael/.cache/wt/tmux.conf new-session", "tmux"],
      ["/usr/libexec/powerd", "other"],
    ];
    for (const [command, expected] of cases) {
      expect(`${command} -> ${classifyProcess(command)}`).toBe(
        `${command} -> ${expected}`,
      );
    }
  });

  test("a shell wrapper is classified by argv[0], not by its payload", () => {
    // Regression: every non-shell pattern matches anywhere on the line,
    // so before SHELL_RE was checked first these were bucketed by
    // whatever their `-c` payload happened to mention — a shell snapshot
    // referencing a wt path counted as "wt itself" burning CPU.
    expect(
      classifyProcess(
        "/bin/zsh -c source /Users/michael/.claude/shell-snapshots/snap.sh && eval 'bun /Users/michael/.wt/src/main.ts ls'",
      ),
    ).toBe("shell");
    expect(classifyProcess("/bin/sh -c 'npx vitest run'")).toBe("shell");
    expect(classifyProcess("-zsh")).toBe("shell");
  });

  test("package-runner scripts are attributed to what the script does", () => {
    // The `pnpm test` parent of a vitest tree names a script, not a
    // binary, so it matched nothing and under-reported the test bucket.
    expect(classifyProcess("node /path/to/bin/pnpm test")).toBe("test");
    expect(classifyProcess("node /path/to/bin/pnpm run typecheck")).toBe("build");
    expect(classifyProcess("node /path/to/bin/pnpm preview --port 4199")).toBe("dev");
  });

  test("a direct binary on the line beats the script-name heuristic", () => {
    // `npm exec vitest run eslint-rules` must be a test run even though
    // "eslint" appears later; `vite build` must not read as a dev server.
    expect(classifyProcess("npm exec vitest run eslint-rules")).toBe("test");
    expect(classifyProcess("npx vite build --outDir dist")).toBe("build");
  });
});

describe("isOrphanedWtInstance", () => {
  const SELF = 999_999;

  test("launchd-parented wt processes match in both launch forms", () => {
    expect(
      isOrphanedWtInstance({ pid: 1882, ppid: 1, command: "bun src/main.ts" }, SELF),
    ).toBe(true);
    expect(
      isOrphanedWtInstance(
        { pid: 8562, ppid: 1, command: "bun /Users/michael/.wt/bin/../src/main.ts" },
        SELF,
      ),
    ).toBe(true);
  });

  test("live-parented instances and self are never orphans", () => {
    expect(
      isOrphanedWtInstance({ pid: 8562, ppid: 61353, command: "bun src/main.ts" }, SELF),
    ).toBe(false);
    expect(
      isOrphanedWtInstance({ pid: SELF, ppid: 1, command: "bun src/main.ts" }, SELF),
    ).toBe(false);
  });

  test("unrelated launchd children don't match", () => {
    expect(
      isOrphanedWtInstance({ pid: 42, ppid: 1, command: "bun src/index.ts" }, SELF),
    ).toBe(false);
    expect(
      isOrphanedWtInstance({ pid: 43, ppid: 1, command: "/usr/sbin/distnoted" }, SELF),
    ).toBe(false);
  });
});
