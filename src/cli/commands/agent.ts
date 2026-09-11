import { Effect } from "effect";

import { operationErrors } from "../../core/errors.ts";
import {
  inspectAgentTargets,
  resolveAgentRoute,
  sendAgentMessageToRoute,
  type AgentRoute,
} from "../../core/harness/agent-routing.ts";
import { getHarness } from "../../core/harness/index.ts";
import { fallbackAdvice } from "../../core/harness/session-messaging.ts";
import { harnessCanResolveSkill } from "../../core/skills.ts";
import { verifyStepsHeadline, workAge } from "../../core/work-status.ts";
import { isMergedRemoval, readWtState, verificationOwedAtRemoval } from "../../core/wtstate.ts";
import { dim, green, red, yellow } from "../colors.ts";

import { parseAgentArgs, skillPrompt } from "./agent-args.ts";

const USAGE = `usage: wt agent send <target> [text...]   send to the target's active agent
       wt agent start <worktree>          start that agent on its prompt.txt brief
       wt agent ls [--json]               list every addressable target and its routing

Targets are worktree slugs or branch names, plus wt, main, dotfiles,
and manager. Routing chooses the target's active harness. If several
are active, the Shift+Tab primary wins; if none is active, that primary
is cold-started. Callers never select Claude, Codex, or OpenCode.

\`send\` submits text at the chosen session's prompt and reads stdin when
no text arguments are supplied. \`start\` is worktree-only and invokes
the bundled start skill using the selected harness's native syntax.`;

const io = operationErrors("wt agent");
const STDIN_SENTINELS = new Set(["-", "/dev/stdin", "/dev/fd/0"]);

function messageText(textArgs: string[]) {
  const joined = textArgs.join(" ").trim();
  if (textArgs.length > 0) return Effect.succeed(joined);
  return io.promise("read stdin", () => Bun.stdin.text()).pipe(
    Effect.map((text) => text.trim()),
  );
}

function explainMissingTarget(requested: string): void {
  const removed = readWtState().removed.find(
    (entry) => entry.slug === requested || entry.branch === requested,
  );
  if (removed) {
    const age = workAge(removed.removedAt);
    const detail = isMergedRemoval(removed)
      ? `archived on merge (${removed.prNumber === undefined ? "PR merged" : `#${removed.prNumber}`}${age ? `, ${age} ago` : ""})`
      : `worktree removed${age ? ` ${age} ago` : ""}`;
    console.error(red(`no live target: ${requested} — ${detail}`));
    if (verificationOwedAtRemoval(removed)) {
      console.error(
        yellow(
          `  UNVERIFIED — still owed: ${verifyStepsHeadline(removed.work!.verifyAfterMerge!)}`,
        ),
      );
    }
    return;
  }
  console.error(red(`unknown agent target: ${requested}`));
  console.error(
    dim("addressable special sessions: wt, main, dotfiles, manager; run `wt agent ls` for worktrees"),
  );
}

function selectionReason(route: AgentRoute): string {
  const { choice } = route;
  if (choice.source === "primary") {
    return "nothing is active there, so this is the Shift+Tab primary";
  }
  if (choice.source === "unavailable") {
    return "wt could not inspect its tmux session registry";
  }
  const active = choice.liveHarnesses ?? [];
  if (active.length === 1) return "it is the only active harness for that target";
  return `${active.length} harnesses are active there, so the Shift+Tab primary wins`;
}

function inspectFailed(): number {
  console.error(red("could not inspect wt's tmux session registry"));
  console.error(dim("no harness was selected or cold-started; retry after the tmux socket is accessible"));
  return 1;
}

const list = Effect.fn("wt agent ls")(function* (json: boolean) {
  const routes = yield* inspectAgentTargets();
  if (routes.some((route) => route.choice.source === "unavailable")) {
    return inspectFailed();
  }
  if (json) {
    console.log(JSON.stringify(routes.map(({ target, choice }) => ({
      target: target.slug,
      kind: target.kind,
      branch: target.branch,
      cwd: target.cwd,
      active_harnesses: choice.liveHarnesses,
      selected_harness: choice.harnessId,
      selection: choice.source,
    })), null, 2));
    return 0;
  }
  for (const route of routes) {
    const harness = getHarness(route.choice.harnessId!);
    const special = route.target.kind === "special" ? " [special]" : "";
    console.log(`${route.target.slug}${special}  ${harness.label}  ${dim(selectionReason(route))}`);
  }
  return 0;
});

export const run = Effect.fn("wt agent")(function* (argv: string[]) {
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
  if (parsed.kind === "list") return yield* list(parsed.json);

  const route = yield* resolveAgentRoute(parsed.target);
  if (!route) {
    explainMissingTarget(parsed.target);
    return 1;
  }
  if (route.choice.source === "unavailable" || route.choice.harnessId === null) {
    return inspectFailed();
  }
  if (parsed.kind === "start" && route.target.kind !== "worktree") {
    console.error(red(`wt agent start is worktree-only: ${route.target.slug} is a special session`));
    console.error(dim(`use wt agent send ${route.target.slug} "<message>" to cold-start and message it`));
    return 2;
  }
  if (
    parsed.kind === "send" &&
    parsed.textArgs.length === 1 &&
    STDIN_SENTINELS.has(parsed.textArgs[0]!)
  ) {
    console.error(
      red(
        `"${parsed.textArgs[0]}" is not a message body; drop it to pipe stdin into wt agent send ${route.target.slug}`,
      ),
    );
    return 2;
  }

  const harnessId = route.choice.harnessId;
  const harness = getHarness(harnessId);
  if (parsed.kind === "start" && !(yield* harnessCanResolveSkill(harnessId, "start"))) {
    console.error(red(`cannot start ${route.target.slug}: ${harness.label} cannot resolve the bundled start skill`));
    console.error(dim("run `wt skills sync start --yes` on this host, then retry `wt agent start`"));
    return 1;
  }
  const text = parsed.kind === "start"
    ? skillPrompt(harness.skillPrefix, "start")
    : yield* messageText(parsed.textArgs);
  if (!text) {
    if (parsed.kind === "send" && parsed.textArgs.length !== 1) {
      console.error(red("nothing to send — pass text args or pipe stdin"));
    }
    return 2;
  }

  const result = yield* sendAgentMessageToRoute(route, text);
  if (!result.ok) {
    console.error(red(`send failed: ${result.reason}`));
    return 1;
  }
  if (result.delivered === false) {
    console.error(red(`✗ ${route.target.slug}'s ${harness.label} session did not receive the prompt`));
    return 1;
  }

  const action = parsed.kind === "start" ? "the start skill" : "the prompt";
  const queued = result.queueState === "queued";
  const accepted = result.queueState === "queued-or-started";
  console.log(green(
    queued
      ? `✓ queued ${action} for ${route.target.slug}'s ${harness.label} session`
      : result.coldStarted
        ? `✓ started ${route.target.slug}'s ${harness.label} session and submitted ${action}`
        : accepted
          ? `✓ accepted ${action} for ${route.target.slug}'s ${harness.label} session`
          : `✓ submitted ${action} to ${route.target.slug}'s ${harness.label} session`,
  ));
  console.log(dim(`${harness.label} chosen because ${selectionReason(route)}`));
  if (result.delivered === null) {
    console.log(dim("submission has no durable delivery receipt; delivery is unknown"));
  } else if (queued) {
    console.log(dim(`durably queued; ${harness.label} will run it after the current turn or prompt`));
  } else if (accepted) {
    console.log(dim("durably accepted; it was queued or started before status could be observed"));
  } else {
    console.log(dim(`delivery confirmed in ${route.target.slug}'s ${harness.label} conversation`));
  }
  if (result.transport === "terminal" && result.fallback.kind !== "unsupported") {
    console.log(dim(fallbackAdvice(result.fallback)));
  }
  return 0;
});
