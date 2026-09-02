import { Data, Effect } from "effect";

import { causeMessage } from "./errors.ts";
import { runOk } from "./proc.ts";

export class WezTermError extends Data.TaggedError("WezTermError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return causeMessage(this.cause);
  }
}

/**
 * WEZTERM_PANE is set by WezTerm for local panes and inherited through
 * multiplexers such as tmux. Unlike TERM_PROGRAM, it also identifies the pane
 * that `wezterm cli` should use to find the containing tab.
 */
export function isRunningInWezTerm(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WEZTERM_PANE);
}

export function wezTermCliPath(
  configuredPath: string | null,
  which: (name: string) => string | null = Bun.which,
): string | null {
  return configuredPath ?? which("wezterm");
}

/** Set the containing WezTerm tab's explicit title. Failure is non-fatal. */
export function setWezTermTabTitle(
  title: string,
  configuredCliPath: string | null,
): Effect.Effect<void, WezTermError> {
  if (!isRunningInWezTerm()) return Effect.void;

  const wezterm = wezTermCliPath(configuredCliPath);
  if (!wezterm) return Effect.void;

  return runOk([wezterm, "cli", "set-tab-title", title]).pipe(
    Effect.mapError((cause) => new WezTermError({ cause })),
    Effect.asVoid,
  );
}
