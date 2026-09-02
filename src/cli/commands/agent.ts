import { getHarness } from "../../core/harness/index.ts";
import { resolveWorktreeHarness } from "../../core/harness/live-target.ts";
import {
  fallbackAdvice,
  sendSessionMessage,
} from "../../core/harness/session-messaging.ts";
import { dirSlug } from "../../core/stage.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { dim, green, red } from "../colors.ts";
import { Data, Effect } from "effect";

import { parseAgentArgs, skillPrompt } from "./agent-args.ts";

const USAGE = `usage: wt agent send <worktree> [text...]   send to the worktree's live agent
       wt agent start <worktree>            start that agent on its prompt.txt brief
       --harness <claude|codex|opencode>    address one explicitly

Both pick the harness with a LIVE session in that worktree, and fall
back to the Shift+Tab primary only when nothing is running there. The
primary is one global setting ("what F12 would spawn next"), not a
per-worktree one, so routing by it alone sent messages to a harness
that was not the one working on the branch.

\`send\` cold-starts the chosen harness when needed and submits the text
at its prompt. With no text arguments, stdin is read.

\`start\` invokes the bundled start skill with the syntax native to the
selected harness (for example /start for Claude, $start for Codex).`;

export class AgentCommandError extends Data.TaggedError("AgentCommandError")<{
  operation: string;
  cause: unknown;
}> {}

function tryCommand<A>(operation: string, evaluate: () => PromiseLike<A>) {
  return Effect.tryPromise({
    try: evaluate,
    catch: (cause) => new AgentCommandError({ operation, cause }),
  });
}

function resolveWorktree(slugOrBranch: string) {
  const slug = slugOrBranch.includes("/")
    ? dirSlug(slugOrBranch)
    : slugOrBranch;
  return tryCommand("list worktrees", () => listWorktrees()).pipe(
    Effect.map((all) => ({
      wt:
        all.find(
          (w) => !w.isMain && (w.slug === slug || w.branch === slugOrBranch),
        ) ?? null,
      // Every slug on the board, so the harness resolver can tell this
      // worktree's `<slug>-codex` session from a NEIGHBOUR worktree whose
      // slug happens to be `<slug>-codex`.
      slugs: new Set(all.map((w) => w.slug)),
    })),
  );
}

function messageText(textArgs: string[]) {
  if (textArgs.length > 0) return Effect.succeed(textArgs.join(" ").trim());
  return tryCommand("read stdin", () => Bun.stdin.text()).pipe(
    Effect.map((text) => text.trim()),
  );
}

export function run(argv: string[]): Effect.Effect<number, AgentCommandError> {
  return Effect.gen(function* () {
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

    const { wt, slugs } = yield* resolveWorktree(parsed.target);
    if (!wt) {
      console.error(red(`no worktree: ${parsed.target}`));
      console.error(dim("addressable worktrees are listed by `wt ls`"));
      return 1;
    }

    const choice = parsed.harness
      ? ({ harnessId: parsed.harness, source: "explicit" } as const)
      : yield* tryCommand("resolve live harness", () =>
          resolveWorktreeHarness(wt.slug, slugs),
        );
    const harnessId = choice.harnessId;
    const harness = getHarness(harnessId);
    // Say which harness and WHY, always. "delivery confirmed in the
    // receiving harness's conversation" is unfalsifiable from here, and
    // three misrouted sends read exactly like three good ones because
    // of it.
    if (choice.source === "primary-unknown") {
      console.error(
        red(
          `could not ask tmux which sessions are live — falling back to the ${harness.label} primary`,
        ),
      );
      console.error(dim(`pass --harness <id> to address one explicitly`));
    }
    const text =
      parsed.kind === "start"
        ? skillPrompt(harness.skillPrefix, "start")
        : yield* messageText(parsed.textArgs);
    if (!text) {
      console.error(red("nothing to send — pass text args or pipe stdin"));
      return 2;
    }

    const result = yield* tryCommand("send session message", () =>
      sendSessionMessage({
        slug: wt.slug,
        cwd: wt.path,
        harnessId,
        managedName: null,
        text,
      }),
    );
    if (!result.ok) {
      console.error(red(`send failed: ${result.reason}`));
      return 1;
    }
    if (result.delivered === false) {
      console.error(
        red(
          `✗ ${wt.slug}'s ${harness.label} session did not receive the prompt`,
        ),
      );
      console.error(dim("attach via the wt TUI (F12) and check the session"));
      return 1;
    }

    const action = parsed.kind === "start" ? "the start skill" : "the prompt";
    console.log(
      green(
        result.coldStarted
          ? `✓ started ${wt.slug}'s ${harness.label} session and submitted ${action}`
          : `✓ submitted ${action} to ${wt.slug}'s ${harness.label} session`,
      ),
    );
    const why =
      choice.source === "explicit"
        ? "you named it with --harness"
        : choice.source === "live"
          ? "it is the harness live in that worktree"
          : "nothing was live there, so this is the Shift+Tab primary";
    console.log(dim(`${harness.label} chosen because ${why}`));
    if (result.delivered === null) {
      console.log(
        dim(
          "submitted at the session prompt; this input leaves no durable delivery receipt",
        ),
      );
    } else {
      console.log(
        dim(`delivery confirmed in ${wt.slug}'s ${harness.label} conversation`),
      );
    }
    if (
      result.transport === "terminal" &&
      result.fallback.kind !== "unsupported"
    ) {
      console.log(dim(fallbackAdvice(result.fallback)));
    }
    return 0;
  });
}
