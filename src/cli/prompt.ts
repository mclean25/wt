import { createInterface } from "node:readline/promises";
import { Data, Effect } from "effect";

export class PromptError extends Data.TaggedError("PromptError")<{
  readonly question: string;
  readonly cause: unknown;
}> {}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function ask(question: string): Effect.Effect<string, PromptError> {
  return Effect.acquireUseRelease(
    Effect.sync(() =>
      createInterface({ input: process.stdin, output: process.stdout }),
    ),
    (readline) =>
      Effect.tryPromise({
        try: () => readline.question(question),
        catch: (cause) => new PromptError({ question, cause }),
      }).pipe(Effect.map((answer) => answer.trim())),
    (readline) => Effect.sync(() => readline.close()),
  );
}

export function confirm(
  question: string,
  defaultYes = false,
): Effect.Effect<boolean, PromptError> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  return ask(question + suffix).pipe(
    Effect.map((raw) => {
      const answer = raw.toLowerCase();
      if (!answer) return defaultYes;
      return answer === "y" || answer === "yes";
    }),
  );
}

export const pickIndex = Effect.fn("pickIndex")(function* (
  items: readonly string[],
  title: string,
): Effect.fn.Return<number | null, PromptError> {
  if (items.length === 0) return null;
  console.log(title);
  items.forEach((item, index) => console.log(`  ${index + 1}. ${item}`));
  const raw = yield* ask(`Pick 1-${items.length} (empty to cancel): `);
  if (!raw) return null;
  const index = parseInt(raw, 10);
  if (Number.isNaN(index) || index < 1 || index > items.length) return null;
  return index - 1;
});
