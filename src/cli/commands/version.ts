import { repoUpdateState, wtVersion } from "../../core/update.ts";
import { hasHelpFlag } from "../args.ts";
import { dim, yellow } from "../colors.ts";

const USAGE = `usage: wt version

Print the running wt version: the source clone's git short hash and
commit date ("-dirty" when the clone has local changes). Notes when
origin is ahead as of the last fetch — no network is touched here;
\`wt update --check\` does the live comparison.`;

export async function run(argv: string[]): Promise<number> {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  console.log(`wt ${wtVersion()}`);
  const state = await repoUpdateState();
  if (state && state.behind > 0 && !state.dirty && state.ahead === 0) {
    console.log(yellow(`${state.behind} commit(s) behind ${state.upstream} — run \`wt update\``));
  } else if (state?.dirty || (state?.ahead ?? 0) > 0) {
    console.log(dim("(clone has local changes — self-update disabled)"));
  }
  return 0;
}
