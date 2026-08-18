import { getHarness, readPrimaryHarness } from "../../core/harness/index.ts";
import { fallbackAdvice, sendSessionMessage } from "../../core/harness/session-messaging.ts";
import { dirSlug } from "../../core/stage.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { dim, green, red } from "../colors.ts";

import { parseAgentArgs, skillPrompt } from "./agent-args.ts";

const USAGE = `usage: wt agent send <worktree> [text...]   send to the configured primary agent
       wt agent start <worktree>            start the primary agent on its prompt.txt brief

\`send\` cold-starts the configured primary harness when needed and
submits the text at its prompt. With no text arguments, stdin is read.

\`start\` invokes the bundled start skill with the syntax native to the
selected harness (for example /start for Claude, $start for Codex).`;

async function resolveWorktree(slugOrBranch: string) {
  const slug = slugOrBranch.includes("/") ? dirSlug(slugOrBranch) : slugOrBranch;
  return (await listWorktrees()).find(
    (wt) => !wt.isMain && (wt.slug === slug || wt.branch === slugOrBranch),
  ) ?? null;
}

async function messageText(textArgs: string[]): Promise<string> {
  if (textArgs.length > 0) return textArgs.join(" ").trim();
  return (await Bun.stdin.text()).trim();
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseAgentArgs(argv);
  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(red(parsed.message));
    console.error(dim(USAGE));
    return 2;
  }

  const wt = await resolveWorktree(parsed.target);
  if (!wt) {
    console.error(red(`no worktree: ${parsed.target}`));
    console.error(dim("addressable worktrees are listed by `wt ls`"));
    return 1;
  }

  const harnessId = readPrimaryHarness();
  const harness = getHarness(harnessId);
  const text = parsed.kind === "start"
    ? skillPrompt(harness.skillPrefix, "start")
    : await messageText(parsed.textArgs);
  if (!text) {
    console.error(red("nothing to send — pass text args or pipe stdin"));
    return 2;
  }

  const result = await sendSessionMessage({
    slug: wt.slug,
    cwd: wt.path,
    harnessId,
    managedName: null,
    text,
  });
  if (!result.ok) {
    console.error(red(`send failed: ${result.reason}`));
    return 1;
  }
  if (result.delivered === false) {
    console.error(red(`✗ ${wt.slug}'s ${harness.label} session did not receive the prompt`));
    console.error(dim("attach via the wt TUI (F12) and check the session"));
    return 1;
  }

  const action = parsed.kind === "start" ? "the start skill" : "the prompt";
  console.log(green(
    result.coldStarted
      ? `✓ started ${wt.slug}'s ${harness.label} session and submitted ${action}`
      : `✓ submitted ${action} to ${wt.slug}'s ${harness.label} session`,
  ));
  if (result.delivered === null) {
    console.log(dim("submitted at the session prompt; this input leaves no durable delivery receipt"));
  } else {
    console.log(dim("delivery confirmed in the receiving harness's conversation"));
  }
  if (result.transport === "terminal" && result.fallback.kind !== "unsupported") {
    console.log(dim(fallbackAdvice(result.fallback)));
  }
  return 0;
}
