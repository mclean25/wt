import { config } from "../../core/config.ts";
import { createWorktree, parseInput } from "../../core/lifecycle.ts";
import { listWorktrees } from "../../core/worktree.ts";
import { setSlugGithubIssue } from "../../core/wtstate.ts";
import { bold, cyan, dim, green, red, yellow } from "../colors.ts";
import { isInteractive, pickIndex } from "../prompt.ts";
import { openInZed } from "../../core/zed.ts";

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
    }
    else if (a === "--no-open") noOpen = true;
    else if (a === "--open") noOpen = false;
    else if (a === "--no-install") noInstall = true;
    else if (a === "--any") any = true;
    else if (a === "--attach") attach = true;
    else if (a === "--gh") {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) return { error: "--gh requires an issue number" };
      gh = n;
    }
    else if (a === "--base") base = argv[++i];
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

export async function run(argv: string[]): Promise<number> {
  const parsed = parse(argv);
  if ("error" in parsed) {
    console.error(red(parsed.error));
    return 2;
  }
  if (!parsed.raw) {
    console.error(
      red(
        "usage: wt new <id [title…]|url|branch|slug> [--slug s] [--gh n] [--attach] [--any] [--base ref] [--no-open] [--no-install]",
      ),
    );
    return 2;
  }

  let branch: string;
  try {
    branch = await parseInput(parsed.raw, {
      slugHint: parsed.slug,
      anyAuthor: parsed.any,
      attach: parsed.attach,
      promptForChoice: isInteractive()
        ? async (id, branches) => {
            const idx = await pickIndex(branches, `Multiple branches for ${id}:`);
            return idx === null ? null : branches[idx]!;
          }
        : undefined,
    });
  } catch (e) {
    console.error(red(e instanceof Error ? e.message : String(e)));
    return 1;
  }

  // Short-circuit if the branch already has a worktree.
  const existing = (await listWorktrees()).find((w) => !w.isMain && w.branch === branch);
  if (existing) {
    console.log(yellow(`Worktree already exists for ${branch}`));
    console.log(`  ${dim("path:")}  ${existing.path}`);
    if (config.sst) console.log(`  ${dim("stage:")} ${existing.stage}`);
    if (parsed.gh) {
      setSlugGithubIssue(existing.slug, parsed.gh);
      console.log(`  ${dim("gh:")}    #${parsed.gh}`);
    }
    if (parsed.open) await openInZed(existing.path);
    return 0;
  }

  const result = await createWorktree(branch, {
    runInstall: parsed.install,
    base: parsed.base,
    onLog: (line) => console.log(dim(line)),
    onPhase: (phase) => console.log(dim(`· ${phase}`)),
  });

  if (!result.ok) {
    console.error(red(result.reason));
    return 1;
  }
  if (parsed.gh) setSlugGithubIssue(result.slug, parsed.gh);

  console.log(green(`✓ created ${bold(cyan(result.slug))}`));
  console.log(`  ${dim("path:")}  ${result.path}`);
  if (parsed.gh) console.log(`  ${dim("gh:")}    #${parsed.gh}`);
  if (config.sst) console.log(`  ${dim("stage:")} ${result.stage}`);

  if (parsed.open) await openInZed(result.path);
  return 0;
}
