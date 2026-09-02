/**
 * `wt section` — read AND write the fleet's grouping.
 *
 * Sections were TUI-only until this command existed, which made them
 * the one part of wtstate that inverts wt's usual contract: everything
 * else an agent asserts and the human reads, but grouping the human
 * asserted and an agent could only read (`wt status --all --json`).
 * That is backwards for the field that encodes BATCHING decisions —
 * "these two ship today, that one is held back" — because batching is
 * exactly what a manager session helps decide. An agent that can
 * propose a merge batch but not record it leaves the human doing
 * clerical work to catch the TUI up with a conversation that already
 * happened.
 *
 * Sections stay a human-owned artifact in the sense that matters: they
 * are asserted, never derived. Nothing in wt infers a section, and
 * this command adds no inference — it only lets the other party to the
 * conversation write down what was agreed. Every move narrates onto
 * the attention feed (the TUI diffs wtstate, see
 * `useWtStateEvents`), so a grouping change an agent makes is
 * something the human sees, not something they discover.
 *
 * Stack sections are excluded throughout: they're synthetic keys
 * derived from the fork-base records, so naming one here would be
 * writing down something wt re-derives on the next render.
 */
import { Effect } from "effect";

import { config } from "../../core/config.ts";
import { operationErrors } from "../../core/errors.ts";
import { buildStackIndex } from "../../core/stack-layout.ts";
import type { Worktree } from "../../core/types.ts";
import { listWorktrees } from "../../core/worktree.ts";
import {
  GROUP_INBOX,
  readWtState,
  removeSection,
  renameSection,
  setSlugSection,
  stackIdFromSectionKey,
} from "../../core/wtstate.ts";
import type { WtState } from "../../core/wtstate.ts";
import { hasHelpFlag } from "../args.ts";
import { bold, cyan, dim, green, red } from "../colors.ts";

const USAGE = `usage: wt section <subcommand> [options]

Sections are the fleet's grouping: the human's batching of worktrees
("To Merge", "On Hold", "Investigations"). They are asserted, never
derived — wt infers nothing here — and the TUI renders rows grouped by
them, with per-section fold state.

  list     wt section [ls] [--json]
  move     wt section mv <slug>... <section> [--only]
  rename   wt section rename <old> <new>
  remove   wt section rm <section>

  <section> is created on first use; \`-\` means the inbox (no section).
  In \`mv\`, the LAST positional is the section and everything before it
  is a slug, so several rows move into one section in a single call.
  \`rename\` onto an existing section MERGES into it (rows append at the
  bottom, keeping their relative order). \`rm\` drops the section and its
  rows fall back to the inbox; no worktree is touched.

  \`mv\` moves a worktree's whole STACK by default — a stack is one merge
  unit — and \`--only\` moves just the named ones. Splitting a stack is
  legitimate, not a mistake: finished parents awaiting verification and
  their unstarted children belong in different buckets, and wt never
  reconciles a split you made on purpose.

Grouping is a decision, not a status: use it to record a batch you and
the human agreed on ("held back from today's release"), and use
\`wt status\` for what a single worktree needs. Moves show up on the
human's attention feed, so record the decision rather than describing
it — but don't reorganize someone's board unasked.`;

const io = operationErrors("wt section");

/** Manual sections only, in display order, with the inbox last. */
function manualSections(state: WtState): string[] {
  return state.sectionsOrder.filter(
    (s) => s !== GROUP_INBOX && stackIdFromSectionKey(s) === null,
  );
}

/**
 * Slugs in a section, in display order. `live` filters to worktrees
 * that still exist: per-slug records outlive the worktree (they're
 * reaped at the next startup), so listing straight from wtstate would
 * show rows that have been archived for days as though they were part
 * of the grouping.
 */
function slugsIn(
  state: WtState,
  section: string | null,
  live: ReadonlySet<string> | null,
): string[] {
  return Object.entries(state.slugs)
    .filter(([slug, v]) => v.section === section && (!live || live.has(slug)))
    .sort((a, b) => a[1].order - b[1].order)
    .map(([slug]) => slug);
}

/**
 * Section names are free text, with two reserved shapes: the NUL
 * prefix is how wt marks synthetic groups (the inbox sentinel, stack
 * keys), so a manual name carrying one would collide with a group the
 * TUI derives. Rejected loudly rather than sanitized — a silently
 * renamed section is worse than a refused one.
 */
function invalidName(name: string): string | null {
  if (!name.trim()) return "a section name can't be empty";
  if (name.startsWith("\0"))
    return "section names can't start with NUL (reserved for wt's derived groups)";
  return null;
}

function resolveSlug(wts: Worktree[], arg: string): string | null {
  const hit = wts.find((w) => w.slug === arg || w.branch === arg);
  return hit ? hit.slug : null;
}

/** Case-insensitive section lookup so `to merge` finds "To Merge". */
function resolveSection(state: WtState, arg: string): string | null {
  const names = manualSections(state);
  if (names.includes(arg)) return arg;
  const lower = arg.toLowerCase();
  const matches = names.filter((n) => n.toLowerCase() === lower);
  return matches.length === 1 ? matches[0]! : null;
}

function runList(
  state: WtState,
  live: ReadonlySet<string>,
  json: boolean,
): number {
  const sections = manualSections(state);
  const folded = new Set(state.foldedSections);
  if (json) {
    const inbox = slugsIn(state, null, live);
    console.log(
      JSON.stringify(
        [
          ...sections.map((name) => ({
            name,
            folded: folded.has(name),
            slugs: slugsIn(state, name, live),
          })),
          { name: null, folded: folded.has(GROUP_INBOX), slugs: inbox },
        ],
        null,
        2,
      ),
    );
    return 0;
  }
  if (sections.length === 0) {
    console.log(dim("No sections. Create one: wt section mv <slug> <section>"));
  }
  for (const name of sections) {
    const rows = slugsIn(state, name, live);
    const tag = folded.has(name) ? dim(" (folded)") : "";
    console.log(`${bold(name)}${dim(` · ${rows.length}`)}${tag}`);
    for (const slug of rows) console.log(`  ${cyan(slug)}`);
  }
  const inbox = slugsIn(state, null, live);
  if (inbox.length > 0) {
    console.log(`${dim("(inbox)")}${dim(` · ${inbox.length}`)}`);
    for (const slug of inbox) console.log(`  ${cyan(slug)}`);
  }
  return 0;
}

/**
 * Every live slug in the same inferred stack as `slug`, including it.
 * A stack is one merge unit, so moving a member usually means moving
 * the unit — but see `--only`: splits are legitimate and common (the
 * finished parents sitting in a verification bucket while their
 * unstarted children sit in a backlog is a real, deliberate board).
 */
function stackSiblings(
  wts: Worktree[],
  slug: string,
  state: WtState,
): string[] {
  const target = wts.find((w) => w.slug === slug);
  if (!target?.branch) return [slug];
  const { byBranch } = buildStackIndex(
    wts.map((w) => ({
      slug: w.slug,
      branch: w.branch,
      baseBranch: state.slugs[w.slug]?.baseBranch,
    })),
  );
  const entry = byBranch.get(target.branch);
  if (!entry) return [slug];
  const bySlug = new Map(wts.map((w) => [w.branch, w.slug]));
  return entry.layout.nodes
    .map((n) => bySlug.get(n.branch))
    .filter((s): s is string => Boolean(s));
}

const runMove = Effect.fnUntraced(function* (
  positional: string[],
  only: boolean,
) {
  if (positional.length < 2) {
    console.error(
      red("usage: wt section mv <slug>... <section>   (`-` = inbox)"),
    );
    return 2;
  }
  const target = positional.at(-1)!;
  const slugArgs = positional.slice(0, -1);
  const toInbox = target === "-";
  if (!toInbox) {
    const bad = invalidName(target);
    if (bad) {
      console.error(red(bad));
      return 2;
    }
  }
  const wts = (yield* listWorktrees()).filter((w) => !w.isMain);
  // A batch moves what it CAN and names what it could not, rather than
  // abandoning the whole thing on the first bad name. The case this is
  // for is not a typo: a fleet manager reads `wt section`, builds an mv
  // from it, and one of those rows archives on merge in between — a
  // race that is routine at fleet scale and costs a re-run every time.
  //
  // Bailing was also worse than it looked. It printed one slug and
  // moved NOTHING, so the output read as "that one failed" while the
  // valid ones had silently not moved either — the reader's next move
  // is to check the rows that appear to have worked, and they haven't.
  const slugs: string[] = [];
  const unresolved: string[] = [];
  for (const arg of slugArgs) {
    const slug = resolveSlug(wts, arg);
    if (slug) slugs.push(slug);
    else unresolved.push(arg);
  }
  const reportSkipped = (): void => {
    if (unresolved.length === 0) return;
    console.error(red(`no such worktree: ${unresolved.join(", ")}`));
    console.error(
      dim(
        "  (removed since you listed them? `wt ls --all` shows recent removals)",
      ),
    );
  };
  if (slugs.length === 0) {
    reportSkipped();
    return 1;
  }
  // An existing section wins over the literal spelling so `mv x "to
  // merge"` lands in "To Merge" instead of forking a near-duplicate.
  const state = yield* io.sync("read wt state", readWtState);
  const section = toInbox
    ? null
    : (resolveSection(state, target) ?? target.trim());
  const created =
    section !== null && !manualSections(state).includes(section);
  // A stack is one merge unit, so the whole unit moves unless --only.
  // Named slugs always move; siblings are pulled in around them.
  const named = new Set(slugs);
  const moving = only
    ? slugs
    : [...new Set(slugs.flatMap((s) => stackSiblings(wts, s, state)))];
  const pulled = moving.filter((s) => !named.has(s));
  // Skip rows already in the target: `setSlugSection` places at the
  // BOTTOM of the section, so re-asserting a row's current section
  // silently reorders it (and narrates a move that didn't happen).
  const changed = moving.filter(
    (s) => (state.slugs[s]?.section ?? null) !== section,
  );
  yield* Effect.all(
    changed.map((slug) =>
      io.sync(`move ${slug} to section`, () => setSlugSection(slug, section)),
    ),
    { concurrency: 1 },
  );
  if (changed.length === 0) {
    console.log(
      `${dim("·")} ${slugs.map((s) => cyan(s)).join(", ")} ${dim(`already in ${section === null ? "the inbox" : section}`)}`,
    );
    reportSkipped();
    // Non-zero whenever the command did not do everything it was asked,
    // even though what it COULD do it did. Re-running is idempotent, so
    // a caller that retries the whole batch loses nothing.
    return unresolved.length > 0 ? 1 : 0;
  }
  const where = section === null ? "the inbox" : bold(section);
  console.log(
    `${green("✓")} ${slugs.map((s) => cyan(s)).join(", ")} → ${where}${created ? dim(" (new)") : ""}`,
  );
  const pulledChanged = pulled.filter((s) => changed.includes(s));
  if (pulledChanged.length > 0) {
    console.log(
      `  ${dim(`moved ${changed.length} (stack) — also ${pulledChanged.join(", ")}`)}`,
    );
    console.log(
      `  ${dim("--only moves just the named worktrees; splitting a stack is legitimate")}`,
    );
  }
  // After the success line, never before: what MOVED is the answer, and
  // a skip printed first reads as the whole command failing.
  reportSkipped();
  return unresolved.length > 0 ? 1 : 0;
});

const runRename = Effect.fnUntraced(function* (positional: string[]) {
  if (positional.length !== 2) {
    console.error(red("usage: wt section rename <old> <new>"));
    return 2;
  }
  const [oldArg, newArg] = positional as [string, string];
  const bad = invalidName(newArg);
  if (bad) {
    console.error(red(bad));
    return 2;
  }
  const state = yield* io.sync("read wt state", readWtState);
  const from = resolveSection(state, oldArg);
  if (!from) {
    console.error(red(`no such section: ${oldArg}`));
    return 1;
  }
  const to = newArg.trim();
  if (from === to) {
    console.log(dim(`already named ${to}`));
    return 0;
  }
  const merging = resolveSection(state, to) !== null;
  yield* io.sync("rename section", () => renameSection(from, to));
  console.log(
    merging
      ? `${green("✓")} merged ${bold(from)} into ${bold(to)}`
      : `${green("✓")} ${bold(from)} → ${bold(to)}`,
  );
  return 0;
});

const runRemove = Effect.fnUntraced(function* (positional: string[]) {
  if (positional.length !== 1) {
    console.error(red("usage: wt section rm <section>"));
    return 2;
  }
  const state = yield* io.sync("read wt state", readWtState);
  const name = resolveSection(state, positional[0]!);
  if (!name) {
    console.error(red(`no such section: ${positional[0]}`));
    return 1;
  }
  const rowCount = yield* io.sync("remove section", () => removeSection(name));
  console.log(
    `${green("✓")} dropped ${bold(name)}${rowCount ? dim(` · ${rowCount} row${rowCount === 1 ? "" : "s"} → inbox`) : ""}`,
  );
  return 0;
});

export const run = Effect.fn("wt section")(function* (argv: string[]) {
  if (hasHelpFlag(argv)) {
    console.log(USAGE);
    return 0;
  }
  if (config.instance.role === "worker") {
    console.error(
      red(
        "sections are controller-owned; run this command on the controller",
      ),
    );
    return 1;
  }
  const positional: string[] = [];
  let json = false;
  let only = false;
  for (const a of argv) {
    if (a === "--json") json = true;
    else if (a === "--only") only = true;
    // `-` is the inbox sentinel for `mv`, not a flag.
    else if (a.startsWith("-") && a !== "-") {
      console.error(red(`unknown flag: ${a}`));
      return 2;
    } else positional.push(a);
  }

  const [sub, ...rest] = positional;
  const isList = sub === undefined || sub === "ls" || sub === "list";
  const isMove = sub === "mv" || sub === "move";
  if (only && !isMove) {
    console.error(red("--only is only valid with `wt section mv`"));
    return 2;
  }
  if (json && !isList) {
    console.error(red("--json is only valid when listing sections"));
    return 2;
  }
  if (isList) {
    const live = new Set(
      (yield* listWorktrees())
        .filter((w) => !w.isMain)
        .map((w) => w.slug),
    );
    const state = yield* io.sync("read wt state", readWtState);
    return runList(state, live, json);
  }
  switch (sub) {
    case "mv":
    case "move":
      return yield* runMove(rest, only);
    case "rename":
      return yield* runRename(rest);
    case "rm":
    case "remove":
      return yield* runRemove(rest);
    default:
      console.error(red(`unknown subcommand: ${sub}`));
      console.log(USAGE);
      return 2;
  }
});
