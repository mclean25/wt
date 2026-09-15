import type { CliRenderer } from "@opentui/core";
import { Effect } from "effect";
import { config } from "../core/config.ts";
import { operationErrors } from "../core/errors.ts";
import { createLogger } from "../core/logger.ts";
import { applyTerminalPalette, saveTerminalPalette, writeConfig } from "../core/tmux.ts";

const io = operationErrors("terminal palette");
const log = createLogger("[terminal]");

/** Query only while OpenTUI owns stdin. Detached harnesses cannot ask the
 * outer terminal themselves, so retain its real defaults before spawning. */
export const syncTerminalPalette = Effect.fn("syncTerminalPalette")(function* (
  renderer: Pick<CliRenderer, "getPalette">,
) {
  yield* Effect.gen(function* () {
    const colors = yield* io.promise("query terminal colors", () =>
      renderer.getPalette({ timeout: 300, size: 16 }),
    );
    if (!(yield* saveTerminalPalette(config.paths.cacheRoot, colors))) return;
    yield* io.sync("write tmux palette configuration", writeConfig);
    yield* applyTerminalPalette(colors);
  }).pipe(Effect.catch((error) => Effect.sync(() => {
    log.warn("terminal palette unavailable; retaining existing defaults", { error: error.message });
  })));
});
