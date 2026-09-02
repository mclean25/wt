import { config } from "../../core/config.ts";
import { currentWorkerInfo } from "../../core/worker-info.ts";
import { Effect } from "effect";

/** Machine-readable controller/worker compatibility handshake. */
export function run(argv: string[]): Effect.Effect<number> {
  return Effect.sync(() => {
    if (argv.length > 0) {
      console.error("usage: wt _hello");
      return 2;
    }
    console.log(JSON.stringify(currentWorkerInfo(config.instance.role)));
    return 0;
  });
}
