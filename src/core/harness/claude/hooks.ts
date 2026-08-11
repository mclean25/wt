import { resolve } from "node:path";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Flag-layer settings installed on every wt-managed Claude process.
 * Claude documents that its messaging socket exists and is exported before
 * SessionStart, making the hook the supported place to capture the per-process
 * address. SessionEnd is best-effort cleanup; discovery still validates every
 * socket because SIGKILL and crashes skip it.
 */
export function claudeMessagingSettings(): string {
  const wt = shellQuote(resolve(import.meta.dir, "..", "..", "..", "..", "bin", "wt"));
  return JSON.stringify({
    crossSessionInbound: "accept",
    hooks: {
      SessionStart: [
        {
          hooks: [{ type: "command", command: `${wt} _claude-hook register` }],
        },
      ],
      SessionEnd: [
        {
          hooks: [{ type: "command", command: `${wt} _claude-hook unregister` }],
        },
      ],
    },
  });
}
