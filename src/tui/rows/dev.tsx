import { config } from "../../core/config.ts";
import { DEV_SERVER_STOPPED } from "../../core/dev-server.ts";
import { NF } from "../icons.ts";
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
      return (
        <text fg={theme.warn} wrapMode="none" truncate>
          {NF.bolt}  starting{dev.port !== null ? ` on ${dev.port}` : ""}…
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
