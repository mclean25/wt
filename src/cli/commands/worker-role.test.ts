import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const MAIN = join(import.meta.dir, "..", "..", "main.ts");

function invoke(role: "controller" | "worker", argv: string[]) {
  const root = mkdtempSync(join(tmpdir(), "wt-role-"));
  roots.push(root);
  const path = join(root, "config.toml");
  writeFileSync(path, `
[instance]
role = "${role}"

[paths]
main_clone = "/tmp/wt-role-main"
worktree_root = "/tmp/wt-role-worktrees"
cache_db = "${root}/cache.sqlite"

[branch]
prefix = "test"
`);
  const env: Record<string, string | undefined> = {
    ...process.env,
    WT_CONFIG: path,
    WT_UPDATE: "off",
    WT_SKILLS: "off",
  };
  delete env.WT_REPO_CONFIG;
  return Bun.spawnSync([process.execPath, MAIN, ...argv], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("worker handshake reports role, protocol, and build", () => {
  const encoded = Buffer.from(JSON.stringify(["_hello"])).toString("base64url");
  const result = invoke("worker", ["_remote", encoded]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    role: "worker",
    protocol: 2,
  });
});

test("controller refuses remote execution requests", () => {
  const encoded = Buffer.from(JSON.stringify(["ls", "--json"])).toString("base64url");
  const result = invoke("controller", ["_remote", encoded]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('role = "worker"');
});

test("controller refuses the worker snapshot endpoint directly", () => {
  const result = invoke("controller", ["_snapshot"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain('role = "worker"');
});

test("worker refuses controller-owned section commands", () => {
  const result = invoke("worker", ["section"]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("controller-owned");
});
