/**
 * `wt manager` — the singleton fleet-coordinator session (the same
 * session the TUI's `m` keybind enters). Attach from a shell, or
 * inject a message from scripts/agents:
 *
 *   wt manager                 attach (create if missing)
 *   wt manager send <text...>  inject a message (cold-starts detached)
 *
 * The manager is a plain harness session in the main clone whose role
 * comes from its playbook skill + what wt sends it. Worktree agents
 * can `wt manager send "..."` to escalate fleet-level questions
 * without pulling the human in; `[[actions]]` with `target =
 * "manager"` and automations brief it through the same injection
 * path.
 */
import { config } from "../../core/config.ts";
import { readPrimaryHarness } from "../../core/harness/primary.ts";
import {
  ensureManagerClaudeName,
  MANAGER_CLAUDE_NAME,
  MANAGER_SLUG,
} from "../../core/manager.ts";
import { attachOrCreate, injectIntoSession } from "../../core/tmux.ts";
import { dim, green, red } from "../colors.ts";

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;

  if (sub === "--help" || sub === "-h") {
    console.log(
      "usage: wt manager                 attach the manager session (create if missing)\n" +
        "       wt manager send <text...>  inject a message into it",
    );
    return 0;
  }

  if (sub === "send") {
    // `--help` after `send` must not be injected as a literal message.
    if (rest[0] === "--help" || rest[0] === "-h") {
      console.log("usage: wt manager send <text...>   inject a message into the manager session");
      return 0;
    }
    const text = rest.join(" ").trim();
    if (!text) {
      console.error(red("wt manager send requires a message"));
      return 2;
    }
    ensureManagerClaudeName();
    const res = await injectIntoSession({
      slug: MANAGER_SLUG,
      cwd: config.paths.mainClone,
      harnessId: readPrimaryHarness(),
      managedName: MANAGER_CLAUDE_NAME,
      text,
    });
    if (!res.ok) {
      console.error(red(`inject failed: ${res.reason}`));
      return 1;
    }
    console.log(
      green(res.coldStarted ? "✓ manager started, message sent" : "✓ sent to manager"),
    );
    console.log(dim("» the manager picks it up as its next turn; press m in wt to watch"));
    return 0;
  }

  if (sub !== undefined) {
    console.error(red(`unknown subcommand: ${sub}`));
    return 2;
  }

  if (!process.stdout.isTTY) {
    console.error(red("wt manager (attach) needs a TTY — did you mean `wt manager send`?"));
    return 2;
  }
  ensureManagerClaudeName();
  const result = await attachOrCreate({
    slug: MANAGER_SLUG,
    cwd: config.paths.mainClone,
    kind: readPrimaryHarness(),
    managedName: MANAGER_CLAUDE_NAME,
  });
  if (result.kind === "spawn-failed") {
    console.error(red(result.reason));
    return 1;
  }
  return 0;
}
