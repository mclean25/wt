/**
 * Registry of harness impls. Single source of truth for TAB-cycle
 * order (= array order here), F12 dispatch, and the sessions picker's
 * "+ new X" sub-affordances.
 *
 * Order is intentional: Claude first because it's the default primary
 * and the most feature-complete impl; Codex follows because it has no
 * Claude registry or summaries.
 */
import { claudeHarness } from "./claude/harness.ts";
import { codexHarness } from "./codex/harness.ts";
import type { Harness, HarnessId } from "./types.ts";

export const HARNESSES: readonly Harness[] = [
  claudeHarness,
  codexHarness,
];

const BY_ID = new Map<HarnessId, Harness>(HARNESSES.map((h) => [h.id, h]));

/** Look up a harness by id. Throws on unknown id — caller picks from the registry. */
export function getHarness(id: HarnessId): Harness {
  const h = BY_ID.get(id);
  if (!h) throw new Error(`unknown harness id: ${id}`);
  return h;
}
