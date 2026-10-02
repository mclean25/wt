import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";

import { copyWorktreeFiles } from "./lifecycle-copy.ts";
import { trackedTmpDirs } from "./test-fixtures.ts";

const { tmp } = trackedTmpDirs();

test("copies hidden matches once, preserves existing files, and excludes git metadata", async () => {
  const root = tmp("wt-copy-files-");
  const source = join(root, "source");
  const destination = join(root, "destination");
  for (const dir of [source, destination, join(source, ".config"), join(source, ".git")]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(source, ".env"), "new env");
  writeFileSync(join(destination, ".env"), "existing env");
  writeFileSync(join(source, ".config", "binary"), new Uint8Array([0, 255, 1]));
  writeFileSync(join(source, ".git", "HEAD"), "private git metadata");
  const logs: string[] = [];
  await Effect.runPromise(copyWorktreeFiles(source, destination,
    [".env", "missing"], [".config/**", "./.config/**", ".git/**", "./.git/**"],
    (line) => logs.push(line),
  ));
  expect(readFileSync(join(destination, ".env"), "utf8")).toBe("existing env");
  expect([...readFileSync(join(destination, ".config", "binary"))]).toEqual([0, 255, 1]);
  expect(logs).toEqual(["copied .config/binary"]);
  expect(existsSync(join(destination, ".git"))).toBe(false);
  expect(existsSync(join(destination, "missing"))).toBe(false);
});

test("an event-loop cancellation stops a copy batch before later writes", async () => {
  const root = tmp("wt-copy-cancel-");
  const source = join(root, "source");
  const destination = join(root, "destination");
  mkdirSync(source);
  for (let i = 0; i < 200; i++) writeFileSync(join(source, `file-${i}`), "payload");
  const controller = new AbortController();
  let copied = 0;
  const result = await Effect.runPromiseExit(copyWorktreeFiles(source, destination, [], ["*"], () => {
    if (++copied === 1) setImmediate(() => controller.abort());
  }), { signal: controller.signal });
  expect(result._tag).toBe("Failure");
  expect(copied).toBeGreaterThan(0);
  expect(copied).toBeLessThan(200);
  // A released creation lock must not have an unjoined copy still writing.
  const completed = copied;
  await Effect.runPromise(Effect.sleep(1));
  expect(copied).toBe(completed);
});

test("a destination error fails instead of reporting a successful copy", async () => {
  const root = tmp("wt-copy-error-");
  const source = join(root, "source");
  mkdirSync(source);
  writeFileSync(join(source, "file"), "payload");
  const destination = join(root, "not-a-directory");
  writeFileSync(destination, "block parent creation");
  const result = await Effect.runPromiseExit(copyWorktreeFiles(source, destination, [], ["*"]));
  expect(result._tag).toBe("Failure");
});
