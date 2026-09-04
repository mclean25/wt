/**
 * Cross-source enumeration of every output the bottom pane could
 * render: the global event log, in-flight + recently-completed action
 * runs, and live tmux sessions (F10 shell, F12 claude). Returns a
 * sorted, stable list and re-evaluates on any underlying source
 * mutation. F11 diff is deliberately excluded from this universe —
 * see `core/outputs.ts`.
 */
import { useMemo, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";

import { actionRegistry } from "../../core/actions.ts";
import {
  type Output,
  actionOutput,
  destroyOutput,
  eventsOutput,
  firehoseOutput,
  sessionOutput,
  sortOutputs,
} from "../../core/outputs.ts";
import {
  harnessTailKey,
  harnessTailRegistry,
  type TailHarnessId,
} from "../../core/harness/tail.ts";
import { sessionTailRegistry, tailKey } from "../../core/harness/claude/tail.ts";
import { shellTailRegistry } from "../../core/shell-tail.ts";
import { tmuxSessionsQuery } from "../../state/queries.ts";
import { events as eventsLog } from "../activity-log.ts";

/**
 * Per-slug first-seen timestamp for destroy entries (the fallback
 * when no slug-tagged event has landed yet). Module-level so
 * re-derivations of the `useOutputs` memo don't reset the clock;
 * pruned against the live destroying set so a second destroy after
 * a recreate restarts the activity stamp.
 */
const destroyFirstSeen = new Map<string, number>();

function destroyStamp(slug: string): number {
  let ts = destroyFirstSeen.get(slug);
  if (ts === undefined) {
    ts = Date.now();
    destroyFirstSeen.set(slug, ts);
  }
  return ts;
}

function pruneDestroyStamps(live: readonly string[]): void {
  if (destroyFirstSeen.size === 0) return;
  const liveSet = new Set(live);
  for (const slug of destroyFirstSeen.keys()) {
    if (!liveSet.has(slug)) destroyFirstSeen.delete(slug);
  }
}

/**
 * Two outputs lists are equivalent for rendering purposes when they
 * agree on membership, order, and every display-relevant field. The
 * deliberate exclusions are `startedAt`/`lastActivity`: they advance on
 * every tail append and only matter through the sort order (covered by
 * comparing order) and the picker's age column (transient). Honest
 * scope note: `sortOutputs` orders live entries by `lastActivity`
 * desc, so TWO OR MORE concurrently-streaming sessions swap positions
 * on most appends and defeat this check while that's happening — the
 * stabilization pays off for the common single-stream and steady
 * states, not for simultaneous multi-session streaming. Safety of the
 * excluded fields rests on the invariant documented next to `Output`
 * in `core/outputs.ts`: every field a consumer renders is either
 * compared here or derivable from `id`.
 */
function outputsEquivalent(
  a: readonly Output[],
  b: readonly Output[],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.id !== y.id ||
      x.kind !== y.kind ||
      x.title !== y.title ||
      x.status !== y.status
    ) {
      return false;
    }
  }
  return true;
}

export function useOutputs(opts: {
  /** Slugs whose lock op is `"remove"` — drives the destroy outputs. */
  destroyingSlugs: readonly string[];
}): readonly Output[] {
  const { destroyingSlugs } = opts;
  const evts = useSyncExternalStore(
    eventsLog.subscribe,
    eventsLog.getSnapshot,
    eventsLog.getSnapshot,
  );
  const actions = useSyncExternalStore(
    actionRegistry.subscribe,
    actionRegistry.getSnapshot,
    actionRegistry.getSnapshot,
  );
  // Subscribed — `lastActivity` for a session is the timestamp of the
  // most recent line in its tail. Without that, sessions would sort
  // by their first-seen-now() stamp forever and an idle 2h-old
  // session would beat a busy 5m-old one. Two registries: claude
  // (jsonl, structured) and shell (pipe-pane log, plain text).
  const claudeTails = useSyncExternalStore(
    sessionTailRegistry.subscribe,
    sessionTailRegistry.getSnapshot,
    sessionTailRegistry.getSnapshot,
  );
  const shellTails = useSyncExternalStore(
    shellTailRegistry.subscribe,
    shellTailRegistry.getSnapshot,
    shellTailRegistry.getSnapshot,
  );
  // Codex session trails — same role as the claude tail, keyed
  // `${slug}:${harnessId}` (single slot per slug per harness).
  const harnessTails = useSyncExternalStore(
    harnessTailRegistry.subscribe,
    harnessTailRegistry.getSnapshot,
    harnessTailRegistry.getSnapshot,
  );
  const sessions = useQuery(tmuxSessionsQuery()).data;

  const computed = useMemo(() => {
    const out: Output[] = [];

    const lastEvtTs = evts[evts.length - 1]?.ts ?? Date.now();
    out.push(eventsOutput(lastEvtTs));
    out.push(firehoseOutput(lastEvtTs));

    for (const run of actions.values()) {
      out.push(actionOutput(run));
    }

    // Destroy in flight: one entry per destroying slug. `lastActivity`
    // is the ts of the latest event tagged with `source = slug` so
    // sort order tracks real progress; the per-slug first-seen
    // timestamp is the stable fallback when no line has landed yet
    // (mirrors the diff/shell session caching above so picker order
    // doesn't flicker on every events recompute).
    if (destroyingSlugs.length > 0) {
      // Set lookup + early break: the events buffer is up to 500
      // lines, scanned on every memo recompute, so per-line work
      // matters. We walk newest → oldest and stop once every
      // destroying slug has a stamp.
      const destroying = new Set(destroyingSlugs);
      const lastBySlug = new Map<string, number>();
      for (let i = evts.length - 1; i >= 0; i--) {
        const e = evts[i]!;
        if (!destroying.has(e.source) || lastBySlug.has(e.source)) continue;
        lastBySlug.set(e.source, e.ts);
        if (lastBySlug.size === destroying.size) break;
      }
      pruneDestroyStamps(destroyingSlugs);
      for (const slug of destroyingSlugs) {
        const startedAt = destroyStamp(slug);
        const lastActivity = lastBySlug.get(slug) ?? startedAt;
        out.push(destroyOutput(slug, startedAt, lastActivity));
      }
    }

    if (sessions) {
      // Claude can host multiple sessions per slug (primary + N
      // named); each is its own output. The tail registry is keyed by
      // tmux session name (`<slug>` or `<slug>~<name>`), shared via
      // `tailKey` so the lookup matches the registry-side key.
      for (const entry of sessions.claude) {
        const tail = claudeTails.get(tailKey(entry.slug, entry.name));
        const startedAt = tail?.startedAt ?? Date.now();
        const lastLineTs = tail?.lines[tail.lines.length - 1]?.ts;
        const lastActivity = lastLineTs ?? startedAt;
        out.push(
          sessionOutput(
            entry.slug,
            "claude",
            startedAt,
            lastActivity,
            entry.name,
          ),
        );
      }
      for (const slug of sessions.shell) {
        const tail = shellTails.get(slug);
        const startedAt = tail?.startedAt ?? Date.now();
        const lastLineTs = tail?.lines[tail.lines.length - 1]?.ts;
        const lastActivity = lastLineTs ?? startedAt;
        out.push(sessionOutput(slug, "shell", startedAt, lastActivity));
      }
      // Codex has one live slot per slug.
      const harnessKinds: TailHarnessId[] = ["codex"];
      for (const kind of harnessKinds) {
        for (const slug of sessions.slugsByHarness[kind]) {
          const tail = harnessTails.get(harnessTailKey(slug, kind));
          const startedAt = tail?.startedAt ?? Date.now();
          const lastLineTs = tail?.lines[tail.lines.length - 1]?.ts;
          const lastActivity = lastLineTs ?? startedAt;
          out.push(sessionOutput(slug, kind, startedAt, lastActivity));
        }
      }
    }

    return sortOutputs(out);
  }, [
    evts,
    actions,
    claudeTails,
    shellTails,
    harnessTails,
    sessions,
    destroyingSlugs,
  ]);
  // Identity stabilization (see `outputsEquivalent`): the sources above
  // mutate on every tail/event append, but App — this hook's caller via
  // useOutputFocus — only needs a new array when the list meaningfully
  // changed.
  const prevRef = useRef<readonly Output[]>([]);
  if (!outputsEquivalent(prevRef.current, computed)) {
    prevRef.current = computed;
  }
  return prevRef.current;
}
