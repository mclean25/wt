import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { eventsConfigEnvironment, ownsEventsAgent, readEventsAgent } from "./agent.ts";

const expected = { WT_CONFIG: "/test/global/config.toml", WT_REPO_CONFIG: "/test/repo/.wt.toml" };
const agent = (env: Record<string, string>) => ({
  EnvironmentVariables: env,
  StandardOutPath: "/test/cache/events/daemon.out.log",
  StandardErrorPath: "/test/cache/events/daemon.err.log",
});

describe("events agent ownership", () => {
  test("accepts the owning repository and rejects missing, relative, or foreign selectors", () => {
    expect(ownsEventsAgent(agent(expected), expected, "/test/cache/events")).toBe(true);
    for (const repo of ["", "relative/.wt.toml", "/another/.wt.toml"]) {
      expect(ownsEventsAgent(agent({ ...expected, WT_REPO_CONFIG: repo }), expected, "/test/cache/events")).toBe(false);
    }
    expect(ownsEventsAgent(agent(expected), expected, "/other/cache/events")).toBe(false);
  });

  test("legacy global-only agents need matching default config and state paths", () => {
    const globalOnly = { WT_CONFIG: "/test/.config/wt/config.toml", WT_REPO_CONFIG: "" };
    expect(ownsEventsAgent(agent({ HOME: "/test" }), globalOnly, "/test/cache/events")).toBe(true);
    expect(ownsEventsAgent(agent({ HOME: "/elsewhere" }), globalOnly, "/test/cache/events")).toBe(false);
    expect(ownsEventsAgent(agent({}), globalOnly, "/test/cache/events")).toBe(false);
    expect(ownsEventsAgent(agent({ XDG_CONFIG_HOME: "/test/.config" }), globalOnly, "/test/cache/events")).toBe(true);
  });

  test("relative overrides become absolute and equivalent symlink paths retain ownership", () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-agent-config-"));
    try {
      const file = join(dir, "config.toml");
      writeFileSync(file, "");
      symlinkSync(file, join(dir, "alias.toml"));
      const env = eventsConfigEnvironment({ WT_CONFIG: "alias.toml", WT_REPO_CONFIG: "config.toml" }, dir);
      expect(env).toEqual({ WT_CONFIG: realpathSync(file), WT_REPO_CONFIG: realpathSync(file) });
      expect(ownsEventsAgent(agent({ WT_CONFIG: join(dir, "alias.toml"), WT_REPO_CONFIG: file }), env, "/test/cache/events")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== "darwin")("reads real XML safely including escaped config paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-agent-plist-"));
    try {
      const path = join(dir, "agent.plist");
      writeFileSync(path, `<?xml version="1.0"?><plist version="1.0"><dict>
        <key>EnvironmentVariables</key><dict>
          <key>WT_CONFIG</key><string>/test/a&amp;b/config.toml</string>
          <key>WT_REPO_CONFIG</key><string>/test/repo/.wt.toml</string>
        </dict>
        <key>StandardOutPath</key><string>/test/cache/events/daemon.out.log</string>
        <key>StandardErrorPath</key><string>/test/cache/events/daemon.err.log</string>
      </dict></plist>`);
      const parsed = await Effect.runPromise(readEventsAgent(path));
      expect(ownsEventsAgent(parsed, { ...expected, WT_CONFIG: "/test/a&b/config.toml" }, "/test/cache/events")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


test("absolute selectors load the same repository from a different child cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wt-agent-child-"));
  try {
    writeFileSync(join(dir, "global.toml"), "");
    writeFileSync(join(dir, ".wt.toml"), readFileSync(join(import.meta.dir, "../../../test/config.toml"), "utf8"));
    const env = eventsConfigEnvironment({ WT_CONFIG: "global.toml", WT_REPO_CONFIG: ".wt.toml" }, dir);
    const module = join(import.meta.dir, "../config.ts");
    const child = Bun.spawn([process.execPath, "-e", `const {config} = await import(${JSON.stringify(module)}); console.log(JSON.stringify({repo: process.env.WT_REPO_CONFIG, main: config.paths.mainClone}));`], {
      cwd: "/",
      env: { ...process.env, ...env },
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ repo: env.WT_REPO_CONFIG, main: "/tmp/wt-ci-fake-main" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
