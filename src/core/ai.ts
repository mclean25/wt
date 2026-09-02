/**
 * Harness-backed naming for worktree summaries.
 *
 * Uses the configured coding-agent harness's non-interactive CLI, so naming
 * shares the user's existing harness authentication and model access. The
 * run is isolated and read-only; see `harness/completion.ts`.
 *
 * One call produces both a title and a description via a line-prefixed
 * format that's robust to small-model formatting drift. Co-generation
 * shares one round trip and one diff-context build per cache key.
 */
import { Data, Effect, Schedule, Semaphore } from "effect";
import { config } from "./config.ts";
import { runHarnessCompletionEffect, type HarnessCompletionError } from "./harness/completion.ts";

const SYSTEM_PROMPT = `You summarise git changes for a developer scanning their worktrees.

Output format, exactly:
TITLE: <single line, 5 to 10 words, present-tense action or noun phrase>
BRIEF: <noun phrase, 2 to 4 words, max 24 characters, no leading verb>
DESCRIPTION: <1 to 3 sentences of plain prose>

Rules:
- TITLE: tight and descriptive, like a good PR title. No quotes. No trailing period.
- BRIEF: ultra-condensed for a narrow list view. Just the *subject* of the change — caveman talk. No verbs ("Add", "Implement", "Fix", "Refactor"...), no articles. Examples: "Auto-merge support" not "Add auto-merge support"; "Diff compactor" not "Refactor the diff compactor"; "Reviewer picker UI" not "Improve reviewer picker UI". Hard cap 24 characters.
- DESCRIPTION: describe what the change does, not which files it touches. No markdown, no headings, no lists.
- Skip filler like "This change..." or "The diff shows...". Lead with the action.
- If the changes feel exploratory or scaffolding, say so.

Return only the formatted output. Nothing before TITLE, nothing after the description.`;

const STACK_SYSTEM_PROMPT = `You name a group of related git branches for a section header in a developer tool.

Output exactly:
TITLE: <name>

Rules:
- Find the common theme — what unifies the branches. Often a feature, subsystem, or area they all touch.
- TITLE: 4 words maximum. Caveman noun phrase, no leading verb ("Add", "Fix", "Refactor"...), no articles, no quotes, no trailing period.
- Examples: "Auto-merge support", "Markdown link popover", "Reviewer picker UI", "Atomic builder claim".
- Name the WORK, not its packaging: never echo words from these instructions ("stack", "branch", "section", "header", "TUI", "group") unless the changes themselves are about that concept.
- If the branches look unrelated, pick the most prominent shared theme rather than listing them.

Return only the TITLE line.`;

export type AiSummary = {
  /** LLM-authored title. Null when the model failed to emit a TITLE: line. */
  title: string | null;
  /**
   * Ultra-short noun-phrase variant of the title for the worktree list,
   * where horizontal space after the issue ID and badge cluster can be
   * as tight as ~20 chars. Always set: parser falls back to the title,
   * then the description, when the model omits the BRIEF: line.
   */
  brief: string;
  /** LLM-authored description. Always set on success — falls back to the whole response if structure was missing. */
  description: string;
};

export class AiNamingError extends Data.TaggedError("AiNamingError")<{
  readonly kind: "not-configured" | "completion" | "invalid-title";
  readonly detail: string;
  readonly cause?: unknown;
}> {
  override get message(): string { return this.detail; }
}

/**
 * Call the configured naming harness with the prepared diff context.
 * Throws on process / parse errors so react-query surfaces
 * them; the details pane renders errors verbatim once retries are
 * exhausted.
 *
 * When `external` is provided (queryFn `signal`), it's chained with
 * the timeout so observer cancellation aborts the in-flight LM call.
 * Without this, switching worktrees fast leaves the prior
 * megabyte-prompt process running to completion,
 * burning latency on a result nobody sees.
 */
export const summarizeDiffEffect = (prompt: string) =>
  callNamingHarnessEffect(SYSTEM_PROMPT, prompt).pipe(Effect.map(parseTitleDescription));
export const summarizeDiff = (prompt: string, external?: AbortSignal): Promise<AiSummary> =>
  Effect.runPromise(summarizeDiffEffect(prompt), { signal: external });

/**
 * Stack-naming round trip. Same client as `summarizeDiff` but a
 * different system prompt and a tiny `max_tokens` since the output is
 * just one line. Input shape is a list of branch summaries; ordering
 * is irrelevant to the model so callers can sort for cache stability.
 *
 * Returns the cleaned title with a hard 6-word ceiling (≤4 prompted,
 * extra slack absorbs small models that overshoot). Throws on
 * transport / HTTP errors; if the model emits a non-TITLE response
 * the whole content is used as a last-resort fallback.
 */
export function summarizeStackEffect(
  members: ReadonlyArray<{ branch: string; brief: string }>,
): Effect.Effect<string, AiNamingError> {
  const userPrompt = `Branches in this stack:\n${members
    .map((m) => `- ${m.branch}: ${m.brief}`)
    .join("\n")}`;
  // A small local model routinely ignores the "never echo TUI/stack/…"
  // rule and hands back a title made purely of the prompt's own
  // packaging vocabulary ("TUI", "Header Stack Section", …). Because
  // titles cache forever under the membership signature, one such answer
  // sticks permanently. Detect a meta-only title, nudge once with the
  // rejected text quoted back, and if it still won't name the work,
  // throw — the section falls back to its bare issue label (ENG-5202)
  // rather than baking in junk.
  return Effect.gen(function* () {
  let lastRejected: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt: string = lastRejected
      ? `${userPrompt}\n\nYour previous answer "${lastRejected}" just echoed words from the instructions. Name the actual WORK these branches do, not the tool or the grouping.`
      : userPrompt;
    const content: string = yield* callNamingHarnessEffect(STACK_SYSTEM_PROMPT, prompt);
    const titleMatch: RegExpMatchArray | null = content.match(/^TITLE:\s*(.+?)\s*$/m);
    const raw: string = (titleMatch?.[1] ?? content).trim();
    const cleaned = cleanInline(raw);
    // Hard ceiling — 4 prompted, slight slack for small-model drift.
    const capped = cleaned.split(/\s+/).slice(0, 6).join(" ");
    if (capped && !isStackTitleMetaOnly(capped)) return capped;
    lastRejected = capped || raw;
  }
  return yield* new AiNamingError({ kind: "invalid-title", detail:
    `stack title: model only echoed meta-vocabulary ("${lastRejected}")` });
  });
}
export const summarizeStack = (
  members: ReadonlyArray<{ branch: string; brief: string }>, external?: AbortSignal,
): Promise<string> => Effect.runPromise(summarizeStackEffect(members), { signal: external });

/**
 * Words the stack-naming prompt uses to describe *itself* (the tool, the
 * packaging, the grouping) rather than any change. A leaked title is one
 * built entirely from these — "TUI", "Header Stack Section" — with no
 * domain word to anchor it.
 *
 * The test is all-or-nothing on purpose: reject only when *every* token
 * is meta. A single real word saves the title, so "Header Stamp" survives
 * even though "header" is on the list (eng-5202-02 genuinely stamps a
 * header) — we never strip individual tokens, which would corrupt a
 * legitimately header-themed stack down to "Stamp".
 */
const STACK_TITLE_META_WORDS = new Set([
  "tui", "stack", "stacks", "branch", "branches", "section", "sections",
  "header", "headers", "group", "groups", "grouping", "developer", "tool",
  "tools", "feature", "features", "subsystem", "subsystems", "area", "areas",
]);

export function isStackTitleMetaOnly(title: string): boolean {
  const tokens = title
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z]/g, ""))
    .filter(Boolean);
  return tokens.length > 0 && tokens.every((t) => STACK_TITLE_META_WORDS.has(t));
}

/**
 * Module-level serial queue over the configured naming harness. A restack /
 * rebase flips many diff hashes at once, and the resulting burst of
 * concurrent summary fetches can stampede the model into request timeouts.
 * One in-flight request at a time keeps each call fast and the failure mode
 * boring. Tasks run on settled predecessors, so one failure doesn't poison
 * the queue.
 */
const namingSemaphore = Semaphore.makeUnsafe(1);

/** Test seam for the cancellation semantics of the shared naming queue. */
export const withNamingPermitEffect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  namingSemaphore.withPermits(1)(effect);

/**
 * One ephemeral CLI turn through the selected harness. Shared by diff and
 * stack naming so both use the same serialization and retry behavior.
 *
 * Calls are serialized through `enqueueNaming`, and the per-call timeout
 * starts when the request actually goes out — not while it waits in the
 * queue, which would re-create the stampede failure with extra steps.
 * A failed attempt gets one retry (transient resets from a busy /
 * model-swapping server recover on the spot); an external abort — the
 * observer was cancelled, nobody wants the result — does not.
 */
function callNamingHarnessEffect(
  systemPrompt: string,
  userPrompt: string,
): Effect.Effect<string, AiNamingError> {
  const naming = config.naming;
  if (!naming) {
    return Effect.fail(new AiNamingError({ kind: "not-configured", detail: "naming is not configured ([naming] missing in config.toml)" }));
  }
  const attempt = runHarnessCompletionEffect(
          naming,
          `${systemPrompt}\n\nINPUT:\n${userPrompt}`,
          config.paths.mainClone,
        ).pipe(
          Effect.mapError((cause: HarnessCompletionError) => new AiNamingError({ kind: "completion", detail: cause.message, cause })),
          Effect.retry(Schedule.max([Schedule.recurs(1), Schedule.spaced("500 millis")])),
        );
  // Semaphore acquisition is interruptible. A query cancelled while queued
  // is removed from the waiter set and never invokes the harness.
  return withNamingPermitEffect(attempt);
}

/**
 * Lenient parser for the model's structured output.
 *
 * Markers are extracted independently so the model can emit them in any
 * order. When DESCRIPTION is missing, the body is whatever follows the
 * last single-line marker; when no markers are present, the whole
 * response becomes the description and title/brief fall back through
 * `brief = title ?? description`.
 *
 * Inline cleanup (`cleanInline`) strips wrapping quotes and trailing
 * periods on TITLE / BRIEF so the output reads cleanly in a terminal
 * even when the model adds them.
 */
export function parseTitleDescription(text: string): AiSummary {
  const trimmed = text.trim();
  const titleMatch = trimmed.match(/^TITLE:\s*(.+?)\s*$/m);
  const briefMatch = trimmed.match(/^BRIEF:\s*(.+?)\s*$/m);
  const descMatch = trimmed.match(/^DESCRIPTION:\s*([\s\S]+)$/m);

  const rawTitle = titleMatch?.[1]?.trim() ?? null;
  const title = rawTitle ? cleanInline(rawTitle) || null : null;
  const rawBrief = briefMatch?.[1]?.trim() ?? null;
  const parsedBrief = rawBrief ? cleanInline(rawBrief) || null : null;

  let description: string;
  if (descMatch) {
    description = descMatch[1]!.trim();
  } else {
    // No DESCRIPTION marker — take everything after the last single-line
    // marker as the body. Falls back to the whole response when no
    // markers were emitted at all.
    const lastMarkerEnd = Math.max(
      titleMatch ? titleMatch.index! + titleMatch[0]!.length : -1,
      briefMatch ? briefMatch.index! + briefMatch[0]!.length : -1,
    );
    description = lastMarkerEnd >= 0 ? trimmed.slice(lastMarkerEnd).trim() : trimmed;
  }

  // Brief is required at the type level; degrade gracefully when the
  // model skips it. Title is preferred (still a single-line phrase),
  // then a hard-truncated description tail.
  const brief = parsedBrief ?? title ?? description.slice(0, 24).trim();

  return { title, brief, description };
}

function cleanInline(t: string): string {
  return t
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\.+$/, "")
    .trim();
}
