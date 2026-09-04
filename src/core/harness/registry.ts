/**
 * Registry of harness impls. Single source of truth for TAB-cycle
 * order (= array order here), F12 dispatch, and the sessions picker's
 * "+ new X" sub-affordances.
 *
 * Order is intentional: Claude first because it's the default primary
 * and the most feature-complete impl; Codex / OpenCode after because
 * they're partial-feature impls today (no busy/idle, no summaries).
 */
import { claudeHarness } from "./claude/harness.ts";
import { codexHarness } from "./codex/harness.ts";
import { opencodeHarness } from "./opencode/harness.ts";
import { config } from "../config.ts";
import type { Harness, HarnessId } from "./types.ts";

export const HARNESSES: readonly Harness[] = [
  claudeHarness,
  codexHarness,
  opencodeHarness,
];

export function visibleHarnesses<T extends Pick<Harness, "id">>(
  harnesses: readonly T[],
  hidden: ReadonlySet<HarnessId>,
): readonly T[] {
  return harnesses.filter((h) => !hidden.has(h.id));
}

/** Harnesses available to automatic routing and interactive TUI surfaces. */
export const VISIBLE_HARNESSES: readonly Harness[] = visibleHarnesses(
  HARNESSES,
  config.harness.hidden,
);

const BY_ID = new Map<HarnessId, Harness>(HARNESSES.map((h) => [h.id, h]));

/** Look up a harness by id. Throws on unknown id — caller picks from the registry. */
export function getHarness(id: HarnessId): Harness {
  const h = BY_ID.get(id);
  if (!h) throw new Error(`unknown harness id: ${id}`);
  return h;
}
