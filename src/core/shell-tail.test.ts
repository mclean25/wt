import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";

import { ShellTailRegistry, shellLogPath } from "./shell-tail.ts";

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { force: true });
});

describe("ShellTailRegistry lifecycle", () => {
  test("stopAll is idempotent and prevents later file activity from reviving a run", async () => {
    const slug = `shell-tail-effect-${process.pid}-${performance.now()}`;
    const path = shellLogPath(slug);
    paths.push(path);
    rmSync(path, { force: true });
    const registry = new ShellTailRegistry();
    registry.ensure(slug);
    registry.stopAll();
    registry.stopAll();

    writeFileSync(path, "late line\n");
    await Bun.sleep(120);
    expect(registry.get(slug)).toBeNull();
  });
});
