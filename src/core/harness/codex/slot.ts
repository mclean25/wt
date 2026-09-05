import { readFileSlice } from "../../tail-util.ts";

/** Persisted as the opening user message, before any assistant response.
 * Keep this text stable: it is the manager's durable ownership stamp.
 * A launch prompt works without changing Codex's config or requiring hooks.
 */
export const CODEX_MANAGER_PROMPT =
  "This is the dedicated wt manager session. Read $manager to initialize, then wait for a request.\n\n<!-- wt:codex-slot=manager:v1 -->";

export const CODEX_MAIN_PROMPT =
  "This is the wt main-clone coding session. Wait for a request.\n\n<!-- wt:codex-slot=main:v1 -->";

type Slot = "manager" | "main";
const owners = new Map<string, Slot>();
const MAX_PREFIX_BYTES = 2 * 1024 * 1024;

/** Only the opening turn can claim ownership. Later quoted prompts cannot. */
export function codexSlotFromPrefix(text: string): Slot | null {
  const lines = text.split("\n");
  lines.pop(); // An incomplete append is not evidence of ownership.
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { return null; }
    if (!event || typeof event !== "object") return null;
    const payload = event.payload;
    if (event.type !== "response_item" || payload?.type !== "message") continue;
    if (payload.role === "assistant") return "main";
    if (payload.role !== "user" || !Array.isArray(payload.content)) continue;
    if (payload.content.some((part: { type?: string; text?: string } | null) =>
      part?.type === "input_text" && part.text === CODEX_MANAGER_PROMPT
    )) return "manager";
    if (payload.content.some((part: { type?: string; text?: string } | null) =>
      part?.type === "input_text" && part.text === CODEX_MAIN_PROMPT
    )) return "main";
  }
  return null;
}

/** Worker-only synchronous reader. Cache only a completed classification;
 * a fresh rollout may not contain its opening prompt yet.
 */
export function codexRolloutBelongsToSlot(path: string, size: number, slug: string): boolean {
  // Ordinary worktrees have their own cwd and need no opening-turn scan.
  if (slug !== "main" && slug !== "manager") return true;
  let owner = owners.get(path);
  if (!owner) {
    let found: Slot | null = null;
    const limit = Math.min(size, MAX_PREFIX_BYTES);
    for (let bytes = Math.min(limit, 64 * 1024); bytes > 0; bytes = Math.min(bytes * 2, limit)) {
      found = codexSlotFromPrefix(readFileSlice(path, 0, bytes));
      if (found || bytes === limit) break;
    }
    if (!found) return false; // Unknown ownership cannot claim either shared-cwd slot.
    if (owners.size >= 8192) owners.clear();
    owners.set(path, found);
    owner = found;
  }
  return (slug === "manager") === (owner === "manager");
}
