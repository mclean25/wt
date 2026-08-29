import { config } from "../../core/config.ts";
import { currentWorkerInfo } from "../../core/worker-info.ts";

/** Machine-readable controller/worker compatibility handshake. */
export async function run(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error("usage: wt _hello");
    return 2;
  }
  console.log(JSON.stringify(currentWorkerInfo(config.instance.role)));
  return 0;
}
