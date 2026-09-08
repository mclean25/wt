import { existsSync } from "node:fs";
import { Effect, Result } from "effect";

import {
  codexAppServerSocketPath,
  readCodexAppServerInfo,
} from "../../core/harness/codex/app-server.ts";
import { run as runProcess } from "../../core/proc.ts";
import { dim, green, red, yellow } from "../colors.ts";

const USAGE = `usage: wt codex selftest

Checks the installed Codex queue command and, when present, the user-managed
app-server daemon. It is read-only: no thread is resumed and no message is sent.`;

export const run = Effect.fn("wt codex")(function* (argv: string[]) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.length !== 1 || argv[0] !== "selftest") {
    console.error(red("expected `wt codex selftest`"));
    console.error(dim(USAGE));
    return 2;
  }

  const version = yield* Effect.result(runProcess(["codex", "--version"], { timeoutMs: 5_000 }));
  if (Result.isFailure(version) || version.success.exitCode !== 0) {
    const reason = Result.isFailure(version)
      ? version.failure.message
      : version.success.stderr.trim() || `exit ${version.success.exitCode}`;
    console.error(red(`✗ Codex CLI unavailable: ${reason}`));
    return 1;
  }
  console.log(green(`✓ ${version.success.stdout.trim()}`));

  const queueHelp = yield* Effect.result(runProcess(
    ["codex", "queue", "--help"],
    { timeoutMs: 5_000 },
  ));
  const queueOk = Result.isSuccess(queueHelp) && queueHelp.success.exitCode === 0;
  console.log(queueOk
    ? green("✓ durable `codex queue` fallback is available")
    : red("✗ this Codex CLI has no usable `queue` subcommand"));

  const socketPath = codexAppServerSocketPath();
  if (!existsSync(socketPath)) {
    console.log(yellow("○ app-server daemon is offline; wt will use `codex queue`"));
    console.log(dim(`  expected local socket: ${socketPath}`));
    return queueOk ? 0 : 1;
  }

  const daemon = yield* Effect.result(readCodexAppServerInfo());
  if (Result.isFailure(daemon)) {
    console.error(red(`✗ app-server socket is present but unusable: ${daemon.failure.message}`));
    console.error(dim("  update Codex or restart the user-managed daemon; wt does not own its lifecycle"));
    return queueOk ? 0 : 1;
  }
  console.log(green(`✓ native app-server queue connected (${daemon.success.userAgent})`));
  console.log(dim("  direct delivery uses a short-lived local control connection and never resumes the thread"));
  return 0;
});
