import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { config } from "./config.ts";
import { createLogger, flushLog } from "./logger.ts";

/**
 * Writes are chained asynchronously, so anything that logs and then exits
 * loses the line unless it flushes first. The lines that matters for are
 * precisely the ones explaining why a process is about to disappear — the
 * events daemon's self-restart notice was lost exactly this way, leaving a
 * pid change with a clean gap in the log.
 */
describe("flushLog", () => {
  test("a line logged immediately before it is on disk after it", async () => {
    const marker = `flushLog-probe-${process.pid}-${performance.now()}`;
    createLogger("[logger-test]").debug(marker);
    await flushLog();
    const day = new Date().toISOString().slice(0, 10);
    const body = readFileSync(join(config.paths.appLogDir, `wt-${day}.log`), "utf8");
    expect(body).toContain(marker);
  });

  test("it resolves rather than throwing when nothing is queued", async () => {
    await flushLog();
    await flushLog();
  });
});
