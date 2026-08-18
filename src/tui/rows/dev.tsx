import { config } from "../../core/config.ts";
import { DEV_SERVER_STOPPED } from "../../core/dev-server.ts";
import { NF } from "../icons.ts";
import { ageMsToText } from "../text.ts";
import { theme } from "../theme.ts";
import type { RowModule } from "./types.ts";

/**
 * `[dev_server]` state row — the local twin of the SST stage row: bolt
 * + URL while the server is up, quiet bolt-off otherwise. `crashed`
 * (the supervisor parked after repeated rapid failures) renders loud
 * with the recovery hint, since the bolt alone can't say "was running,
 * gave up".
 */
export const devRow: RowModule = {
  id: "dev",
  label: "dev",
  visible: () => config.devServer !== null,
  sources: ({ row }) => [row.fields.dev],
  render: ({ row }) => {
    const dev = row.fields.dev.data ?? DEV_SERVER_STOPPED;
    if (dev.running) {
      return (
        <text fg={theme.warn} wrapMode="none" truncate>
          {NF.bolt}  {dev.url ?? `port ${dev.port}`}
        </text>
      );
    }
    if (dev.crashed) {
      return (
        <text fg={theme.err} wrapMode="none" truncate>
          {NF.bolt}  crashed — restart via ! or `wt dev logs`
        </text>
      );
    }
    if (dev.starting) {
      // The elapsed time is the point, not decoration: a stack that has
      // to bring docker up takes minutes, so `starting` alone can't tell
      // "booting" from "wedged" — one worktree sat here for a quarter of
      // an hour with nothing on the board to say which it was.
      const age = dev.since === null ? "" : ` ${ageMsToText(Date.now() - dev.since)}`;
      return (
        <text fg={theme.warn} wrapMode="none" truncate>
          {NF.bolt}  starting{dev.port !== null ? ` on ${dev.port}` : ""}…{age}
        </text>
      );
    }
    // Queued behind `[dev_server] max_concurrent`. Without this the row
    // says "not running" while an agent sits in `wt dev start --wait`,
    // which reads as an agent that stopped working rather than one that
    // is waiting its turn.
    if (dev.waiting) {
      return (
        <text fg={theme.fgDim} wrapMode="none" truncate>
          {NF.boltOff}  queued #{dev.waiting.rank + 1} for a slot (
          {ageMsToText(Date.now() - dev.waiting.since)})
        </text>
      );
    }
    return (
      <text fg={theme.fgDim} wrapMode="none" truncate>
        {NF.boltOff}  not running
      </text>
    );
  },
};
