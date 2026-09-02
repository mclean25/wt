import { Data, Effect } from "effect";

import { config } from "../../core/config.ts";
import { createWorktree, parseInputEffect } from "../../core/lifecycle.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { setSlugGithubIssue } from "../../core/wtstate.ts";
import { hasHelpFlag } from "../args.ts";
import { bold, cyan, dim, green, red, yellow } from "../colors.ts";
import { isInteractive, pickIndexEffect } from "../prompt.ts";
import { openInEditor } from "../../core/editor.ts";

const USAGE =
  "usage: wt new <id [title…]|url|branch|slug> [--slug s] [--gh n] [--attach] [--any] [--base ref] [--no-open] [--no-install]";

type Flags = {
  slug?: string;
  open: boolean; // default: tty
  install: boolean;
  raw?: string;
  any: boolean;
  attach: boolean;
  gh?: number;
  base?: string;
};

function parse(argv: string[]): Flags | { error: string } {
  let slug: string | undefined;
  let noOpen = false;
  let noInstall = false;
  const positionals: string[] = [];
  let any = false;
  let attach = false;
  let gh: number | undefined;
  let base: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--slug") {
      slug = argv[++i];
      if (!slug) return { error: "--slug requires a value" };
    } else if (a === "--no-open") noOpen = true;
    else if (a === "--open") noOpen = false;
    else if (a === "--no-install") noInstall = true;
    else if (a === "--any") any = true;
    else if (a === "--attach") attach = true;
    else if (a === "--gh") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0)
        return { error: "--gh requires an issue number" };
      gh = n;
    } else if (a === "--base") base = argv[++i];
    else if (a.startsWith("--")) return { error: `unknown flag: ${a}` };
    else positionals.push(a);
  }
  if (base !== undefined && !base) return { error: "--base requires a ref" };
  return {
    slug,
    open: !noOpen && isInteractive(),
    install: !noInstall,
    // Multiple positionals are one input: `wt new ENG-1953 fix calendar`
    // reads as id + pasted title (parseInput slugifies the tail).
    raw: positionals.length > 0 ? positionals.join(" ") : undefined,
    any,
    attach,
    gh,
    base,
  };
}

export class NewCommandError extends Data.TaggedError("NewCommandError")<{
  readonly operation: string;
  readonly cause: unknown;
}> {}

export class EditorOpenError extends Data.TaggedError("EditorOpenError")<{
  readonly path: string;
  readonly cause: unknown;
}> {}

function commandPromise<A>(
  operation: string,
  f: () => Promise<A>,
): Effect.Effect<A, NewCommandError> {
  return Effect.tryPromise({
    try: f,
    catch: (cause) => new NewCommandError({ operation, cause }),
  });
}

function commandIo<A>(
  operation: string,
  f: () => A,
): Effect.Effect<A, NewCommandError> {
  return Effect.try({
    try: f,
    catch: (cause) => new NewCommandError({ operation, cause }),
  });
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function openBestEffort(path: string): Effect.Effect<void, never> {
  return Effect.tryPromise({
    try: () => openInEditor(path),
    catch: (cause) => new EditorOpenError({ path, cause }),
  }).pipe(
    Effect.catchTag("EditorOpenError", (error) =>
      Effect.sync(() => console.error(red(causeMessage(error.cause)))),
    ),
  );
}

export function run(argv: string[]): Effect.Effect<number, NewCommandError> {
  return Effect.gen(function* () {
    if (hasHelpFlag(argv)) {
      console.log(USAGE);
      return 0;
    }
    const parsed = parse(argv);
    if ("error" in parsed) {
      console.error(red(parsed.error));
      return 2;
    }
    if (!parsed.raw) {
      console.error(red(USAGE));
      return 2;
    }

    const parsedBranch = yield* Effect.result(
      parseInputEffect(parsed.raw, {
        slugHint: parsed.slug,
        anyAuthor: parsed.any,
        attach: parsed.attach,
        promptForChoice: isInteractive()
          ? (id, branches) =>
              pickIndexEffect(branches, `Multiple branches for ${id}:`).pipe(
                Effect.map((idx) => (idx === null ? null : branches[idx]!)),
              )
          : undefined,
      }),
    );
    if (parsedBranch._tag === "Failure") {
      console.error(red(parsedBranch.failure.message));
      return 1;
    }
    const branch = parsedBranch.success;

    // Short-circuit if the branch already has a worktree.
    const existing = (yield* commandPromise(
      "list worktrees",
      listWorktrees,
    )).find((w) => !w.isMain && w.branch === branch);
    if (existing) {
      console.log(yellow(`Worktree already exists for ${branch}`));
      console.log(`  ${dim("path:")}  ${existing.path}`);
      if (config.sst) console.log(`  ${dim("stage:")} ${existing.stage}`);
      if (parsed.gh) {
        yield* commandIo("set GitHub issue", () =>
          setSlugGithubIssue(existing.slug, parsed.gh!),
        );
        console.log(`  ${dim("gh:")}    #${parsed.gh}`);
      }
      if (parsed.open) yield* openBestEffort(existing.path);
      return 0;
    }

    const result = yield* commandPromise("create worktree", () =>
      createWorktree(branch, {
        runInstall: parsed.install,
        base: parsed.base,
        onLog: (line) => console.log(dim(line)),
        onPhase: (phase) => console.log(dim(`· ${phase}`)),
      }),
    );

    if (!result.ok) {
      console.error(red(result.reason));
      return 1;
    }
    if (parsed.gh) {
      yield* commandIo("set GitHub issue", () =>
        setSlugGithubIssue(result.slug, parsed.gh!),
      );
    }

    console.log(green(`✓ created ${bold(cyan(result.slug))}`));
    console.log(`  ${dim("path:")}  ${result.path}`);
    if (parsed.gh) console.log(`  ${dim("gh:")}    #${parsed.gh}`);
    if (config.sst) console.log(`  ${dim("stage:")} ${result.stage}`);

    if (parsed.open) yield* openBestEffort(result.path);
    return 0;
  });
}
