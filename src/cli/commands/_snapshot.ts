import { config } from "../../core/config.ts";
import { collectWorkerSnapshot } from "../../core/worktree-snapshot.ts";

/** Versioned machine contract consumed by a controller over SSH. */
export async function run(argv: string[]): Promise<number> {
  if (argv.length > 0) {
    console.error("usage: wt _snapshot");
    return 2;
  }
  if (config.instance.role !== "worker") {
    console.error('worker snapshot requires [instance] role = "worker" on this host');
    return 1;
  }
  console.log(JSON.stringify(await collectWorkerSnapshot()));
  return 0;
}
