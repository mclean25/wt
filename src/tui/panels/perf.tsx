/**
 * The `P` overlay — a filtered, wt-scoped `btop`.
 *
 * Framing is deliberate: the headline answers "is this us?" before any
 * per-process detail, because that's the question you open this with.
 * Everything below it is wt-downstream unless a block says otherwise.
 *
 * Presentational only. Sampling lives in `core/perf.ts` behind
 * `perfSnapshotQuery`; this file never shells out.
 */
import { useTerminalDimensions } from "@opentui/react";

import {
  CATEGORY_LABEL,
  shortCommand,
  type PerfProc,
  type PerfSnapshot,
} from "../../core/perf.ts";
import type { KeyHintPair } from "../key-hint.tsx";
import { Modal } from "../modal.tsx";
import { theme } from "../theme.ts";

/** Status of the `i` inject-and-enter flow, surfaced in the hint row. */
export type PerfInjectState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "failed"; reason: string };

const BAR_W = 22;
const LABEL_W = 16;

/** Share of capacity above which the bar reads as pressure, not use. */
const WARN_AT = 0.6;
const HOT_AT = 0.9;

function loadColor(fraction: number): string {
  if (fraction >= HOT_AT) return theme.err;
  if (fraction >= WARN_AT) return theme.warn;
  return theme.ok;
}

function pct(n: number): string {
  return `${n.toFixed(0)}%`;
}

/** `34M` under a gig, `2.3G` above — `0.0G` reads as broken. */
function mem(mb: number): string {
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)}G` : `${Math.max(0, Math.round(mb))}M`;
}

/** Fixed-width right-aligned cell, so columns line up without a table. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

/** Left-aligned fixed-width cell, `…`-ellipsized when it doesn't fit. */
function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const cut = text.length > width ? `${text.slice(0, width - 1)}…` : text;
  return cut + " ".repeat(width - cut.length);
}

/**
 * Columns available INSIDE the modal's scroll area. Mirrors the Modal
 * geometry (6% insets each side above the narrow cutoff, else full
 * width; 1 border + 1 padding each side) minus room for the scrollbox
 * scrollbar. Every row below is preformatted in JS to this budget —
 * terminal cells never rely on the renderer clipping overlong text,
 * which is exactly what used to wrap/garble long command lines.
 */
function useContentWidth(): number {
  const { width } = useTerminalDimensions();
  const modalW = width < 60 ? width : width - Math.round(width * 0.06) * 2;
  return Math.max(36, modalW - 4 /* border+padding */ - 2 /* scrollbar */);
}

function Bar({
  value,
  max,
  color,
  width = BAR_W,
}: {
  value: number;
  max: number;
  color?: string;
  width?: number;
}) {
  const fraction = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  // At least one cell whenever the value is non-zero: a 3%-of-capacity
  // row rounding to an empty bar reads as "nothing running", which is
  // the opposite of what it means.
  const filled =
    value > 0 ? Math.max(1, Math.round(fraction * width)) : 0;
  return (
    <text>
      <span fg={color ?? loadColor(fraction)}>{"█".repeat(filled)}</span>
      <span fg={theme.borderDim}>{"░".repeat(Math.max(0, width - filled))}</span>
    </text>
  );
}

function MeterRow({
  label,
  value,
  max,
  trailing,
  color,
  width,
}: {
  label: string;
  value: number;
  max: number;
  trailing: string;
  color?: string;
  /** Content budget; the trailing text is `…`-clipped to what remains. */
  width: number;
}) {
  const trailW = Math.max(0, width - LABEL_W - BAR_W - 2);
  return (
    <box flexDirection="row">
      <box width={LABEL_W} flexShrink={0}>
        <text fg={theme.fgDim} wrapMode="none">{label}</text>
      </box>
      <box width={BAR_W} flexShrink={0}>
        <Bar value={value} max={max} color={color} />
      </box>
      <text fg={theme.fg} wrapMode="none">{"  "}{fit(trailing, trailW).trimEnd()}</text>
    </box>
  );
}

function SectionHeader({ title, note }: { title: string; note?: string }) {
  return (
    <box flexDirection="column" marginTop={1}>
      <box backgroundColor={theme.rowSelectedBg} paddingLeft={1}>
        <text fg={theme.fgBright} attributes={1}>
          {title}
        </text>
      </box>
      {note ? (
        <text fg={theme.fgDim} wrapMode="word">
          {note}
        </text>
      ) : null}
    </box>
  );
}

/**
 * One process list: fully preformatted single-line rows
 * (`cpu mem [session] command`), truncated in JS to the width budget.
 * The session column sizes to the longest name present (capped), and
 * near-idle rows are folded into a "+N idle" line — this is the
 * "heaviest" list, and `sleep`/wrapper rows at 0% are noise.
 */
function ProcList({
  procs,
  ceiling,
  width,
}: {
  procs: PerfProc[];
  ceiling: number;
  width: number;
}) {
  const shown = procs.filter((p) => p.cpu >= 0.5 || p.rssMb >= 100);
  const visible = shown.length >= 3 ? shown : procs.slice(0, 3);
  const hidden = procs.length - visible.length;
  const sessions = visible.some((p) => p.session);
  const sessW = sessions
    ? Math.min(16, Math.max(...visible.map((p) => p.session?.length ?? 0)))
    : 0;
  // "  cpu% memM  [session  ]command…"
  const cmdW = width - 5 - 1 - 5 - 2 - (sessions ? sessW + 2 : 0);
  return (
    <box flexDirection="column">
      {visible.map((p) => (
        <text key={p.pid} wrapMode="none">
          <span fg={loadColor(p.cpu / ceiling)}>{pad(pct(p.cpu), 5)}</span>
          <span fg={theme.fgDim}>{pad(mem(p.rssMb), 6)}</span>
          {"  "}
          {sessions ? (
            <span fg={theme.accentAlt}>{fit(p.session ?? "", sessW + 2)}</span>
          ) : null}
          <span fg={theme.fg}>{fit(shortCommand(p.command, cmdW), cmdW)}</span>
        </text>
      ))}
      {procs.length === 0 ? <text fg={theme.fgDim}>none</text> : null}
      {hidden > 0 ? (
        <text fg={theme.fgDim}>{`      + ${hidden} more near idle (<0.5% cpu, <100M)`}</text>
      ) : null}
    </box>
  );
}

/**
 * The one-line verdict. `systemCpu` is the sum of every process's %CPU,
 * so the comparison is "of the work happening right now, how much is
 * ours" — not a share of installed capacity, which would read as
 * reassuringly small on a 12-core box even when wt owns all of it.
 */
function Verdict({ snapshot }: { snapshot: PerfSnapshot }) {
  const share = snapshot.systemCpu <= 0 ? 0 : snapshot.wtCpu / snapshot.systemCpu;
  const busy = snapshot.systemCpu / (snapshot.cores * 100);
  // Idle machine: the share is real but nobody cares whose 4% it is.
  if (busy < 0.25) {
    return (
      <text fg={theme.ok}>
        machine is not busy — {pct(snapshot.systemCpu)} of{" "}
        {pct(snapshot.cores * 100)} in use, whatever feels slow is probably not CPU
      </text>
    );
  }
  return share >= 0.5 ? (
    <text fg={theme.warn}>
      wt is most of the load — {pct(snapshot.wtCpu)} of the{" "}
      {pct(snapshot.systemCpu)} currently in use ({(share * 100).toFixed(0)}%)
    </text>
  ) : (
    <text fg={theme.info}>
      wt is NOT most of the load — {pct(snapshot.wtCpu)} of the{" "}
      {pct(snapshot.systemCpu)} currently in use ({(share * 100).toFixed(0)}%)
    </text>
  );
}

export function PerfOverlay({
  snapshot,
  error,
  inject,
}: {
  snapshot: PerfSnapshot | undefined;
  /** Sampler failure (e.g. `ps` missing or wedged). Rendered verbatim. */
  error: Error | null;
  inject: PerfInjectState;
}) {
  const hints: KeyHintPair[] = [
    ["j k", "scroll"],
    ["i", "investigate in wt session"],
    ["r", "resample"],
    ["P / esc / q", "close"],
  ];

  if (!snapshot) {
    return (
      <Modal
        title="perf"
        inset={{ top: "8%", right: "6%", bottom: "8%", left: "6%" }}
        hints={hints}
      >
        <box flexGrow={1} alignItems="center" justifyContent="center">
          {error ? (
            <text fg={theme.err} wrapMode="word">
              sampling failed: {error.message}
            </text>
          ) : (
            <text fg={theme.fgDim}>sampling…</text>
          )}
        </box>
      </Modal>
    );
  }

  const ceiling = snapshot.cores * 100;
  const contentW = useContentWidth();
  const injectLine =
    inject.kind === "sending" ? (
      <text fg={theme.accent}>sending snapshot to the wt session…</text>
    ) : inject.kind === "failed" ? (
      <text fg={theme.err}>inject failed: {inject.reason}</text>
    ) : null;

  return (
    <Modal
      title={`perf · ${snapshot.wtProcCount} procs downstream of wt`}
      inset={{ top: "8%", right: "6%", bottom: "8%", left: "6%" }}
      hints={hints}
    >
      <box flexShrink={0} flexDirection="column" marginBottom={1}>
        <Verdict snapshot={snapshot} />
        {/* A later sample failing leaves the last good one on screen —
            say so rather than letting it read as live. */}
        {error ? (
          <text fg={theme.err} wrapMode="word">
            resample failed (showing last good sample): {error.message}
          </text>
        ) : null}
        {injectLine}
      </box>
      <scrollbox focused scrollY flexGrow={1}>
        <box flexDirection="column">
          <MeterRow
            label="cpu (all)"
            value={snapshot.systemCpu}
            max={ceiling}
            width={contentW}
            trailing={`${pct(snapshot.systemCpu)} of ${pct(ceiling)} · ${snapshot.cores} cores`}
          />
          <MeterRow
            label="cpu (wt)"
            value={snapshot.wtCpu}
            max={ceiling}
            width={contentW}
            trailing={`${pct(snapshot.wtCpu)} · ${mem(snapshot.wtRssMb)} rss`}
          />
          <MeterRow
            label="memory"
            value={snapshot.memUsedMb}
            max={snapshot.memTotalMb}
            width={contentW}
            trailing={`${mem(snapshot.memUsedMb)} of ${mem(snapshot.memTotalMb)}`}
          />
          <box flexDirection="row">
            <box width={LABEL_W} flexShrink={0}>
              <text fg={theme.fgDim}>load avg</text>
            </box>
            <text fg={theme.fg}>
              {snapshot.loadAvg.map((n) => n.toFixed(2)).join("   ")}
              <span fg={theme.fgDim}>{"   1m / 5m / 15m"}</span>
            </text>
          </box>
        </box>

        <SectionHeader title="wt downstream by category" />
        <box flexDirection="column">
          {snapshot.categories.map((b) => (
            <MeterRow
              key={b.category}
              label={CATEGORY_LABEL[b.category]}
              value={b.cpu}
              max={ceiling}
              width={contentW}
              trailing={`${pad(pct(b.cpu), 5)}  ${pad(mem(b.rssMb), 6)}  ${b.count} proc${b.count === 1 ? "" : "s"}`}
            />
          ))}
          {snapshot.categories.length === 0 ? (
            <text fg={theme.fgDim}>nothing running downstream of wt</text>
          ) : null}
        </box>

        {snapshot.sessions.length > 0 ? (
          <>
            <SectionHeader title="by session" />
            <box flexDirection="column">
              {snapshot.sessions.map((s) => (
                <MeterRow
                  key={s.name}
                  label={fit(s.name, LABEL_W - 1).trimEnd()}
                  value={s.cpu}
                  max={ceiling}
                  width={contentW}
                  trailing={`${pad(pct(s.cpu), 5)}  ${pad(mem(s.rssMb), 6)}  ${s.summary}`}
                />
              ))}
            </box>
          </>
        ) : null}

        <SectionHeader
          title="heaviest processes downstream of wt"
          note="%cpu is a lifetime decaying average, not an instantaneous sample — read it as sustained pressure."
        />
        <ProcList procs={snapshot.top} ceiling={ceiling} width={contentW} />

        <SectionHeader
          title="heaviest processes NOT downstream of wt"
          note="if the answer to 'why is my machine slow' is here, it isn't wt or the agents."
        />
        <ProcList procs={snapshot.outsiders} ceiling={ceiling} width={contentW} />
      </scrollbox>
    </Modal>
  );
}
