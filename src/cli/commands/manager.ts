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
 * can `wt manager send "..."` to escalate fleet-level questions or
 * report papercuts (`"papercut: ..."`) without pulling the human in —
 * fire-and-forget in both directions, nothing is returned to the
 * caller; `[[actions]]` with `target = "manager"` and automations
 * brief it through the same injection path.
 */
import { config } from "../../core/config.ts";
import { readPrimaryHarness } from "../../core/harness/primary.ts";
import {
  appendManagerReport,
  ensureManagerClaudeName,
  MANAGER_CLAUDE_NAME,
  MANAGER_SLUG,
  type ManagerReportLevel,
} from "../../core/manager.ts";
import { attachOrCreate, injectIntoSession } from "../../core/tmux.ts";
import { hasHelpFlag } from "../args.ts";
import { dim, green, red } from "../colors.ts";

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;

  if (hasHelpFlag([sub ?? ""])) {
    console.log(
      "usage: wt manager                 attach the manager session (create if missing)\n" +
        "       wt manager send <text...>  inject a message into it (fleet question,\n" +
        "                                  or \"papercut: ...\" — fire and forget)\n" +
        "       wt manager report [--ok|--warn|--err] <text...>\n" +
        "                                  surface a result on wt's attention feed",
    );
    return 0;
  }

  if (sub === "report") {
    if (hasHelpFlag([rest[0] ?? ""])) {
      console.log(
        "usage: wt manager report [--info|--ok|--warn|--err] <text...>\n" +
          "surface a short result line on the wt TUI's attention feed (default level: info)",
      );
      return 0;
    }
    // Level flags are only recognized at the FRONT of the message —
    // the rest is free text and a literal `--err` mid-sentence sends.
    let level: ManagerReportLevel = "info";
    let words = rest;
    const flag = words[0];
    if (flag === "--ok" || flag === "--warn" || flag === "--err" || flag === "--info") {
      level = flag.slice(2) as ManagerReportLevel;
      words = words.slice(1);
    }
    const text = words.join(" ").trim();
    if (!text) {
      console.error(red("wt manager report requires a message"));
      return 2;
    }
    appendManagerReport(level, text);
    console.log(green("✓ reported"));
    console.log(dim("» surfaces on the wt attention feed (a running TUI picks it up live)"));
    return 0;
  }

  if (sub === "send") {
    // Only the immediate next token is checked for --help — the rest of
    // `rest` is free-text message content and must not be scanned for it
    // (a message that happens to contain the word "--help" still sends).
    if (hasHelpFlag([rest[0] ?? ""])) {
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
    // Confirmed against the manager's transcript, not assumed — see the
    // note in `injectIntoSession`. A papercut report that never arrived
    // is worse than one that failed loudly.
    if (res.delivered === false) {
      console.error(red("✗ the manager session did not receive the message"));
      console.error(
        dim(
          res.resent
            ? "re-sent once and still nothing in its transcript — press m in wt and check the pane"
            : "something in its pane consumed the input — press m in wt and check the pane",
        ),
      );
      return 1;
    }
    console.log(
      green(res.coldStarted ? "✓ manager started, message sent" : "✓ sent to manager"),
    );
    if (res.resent) {
      console.log(dim("» the first attempt was swallowed on startup; re-sent"));
    }
    console.log(dim("» the manager picks it up as its next turn; press m in wt to watch"));
    // Teach the better channel where one exists (same footer idiom as
    // `wt status`). An agent calling this from inside a Claude Code
    // session (env markers below ride every Bash subprocess) holds a
    // peer-messaging tool that reaches a LIVE manager directly —
    // richer than tmux typing and with delivery confirmation. Only
    // when the manager was already running: a cold-started session
    // has no peer address until it boots, so this path was the right
    // call. Delivery above is unchanged either way — teach, never
    // double-send. wt itself keeps using tmux injection: it's not an
    // agent and has no peer channel (deliberately no reverse-
    // engineering of the harness's private socket protocol).
    const insideAgent =
      !!process.env["CLAUDE_CODE_ENTRYPOINT"] ||
      (process.env["AI_AGENT"] ?? "").startsWith("claude-code");
    if (!res.coldStarted && insideAgent) {
      console.log(
        dim(
          "» the manager is live and addressable as 'manager' via your peer-messaging tool (SendMessage) — prefer that channel for agent-to-manager messages",
        ),
      );
    }
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
