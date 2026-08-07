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

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)}G`;
}

/** Fixed-width right-aligned cell, so columns line up without a table. */
function pad(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
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
}: {
  label: string;
  value: number;
  max: number;
  trailing: string;
  color?: string;
}) {
  return (
    <box flexDirection="row">
      <box width={LABEL_W} flexShrink={0}>
        <text fg={theme.fgDim}>{label}</text>
      </box>
      <box width={BAR_W} flexShrink={0}>
        <Bar value={value} max={max} color={color} />
      </box>
      <box flexGrow={1} flexShrink={1}>
        <text fg={theme.fg}>{"  "}{trailing}</text>
      </box>
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

function ProcRow({ proc, ceiling }: { proc: PerfProc; ceiling: number }) {
  return (
    <box flexDirection="row">
      <box width={7} flexShrink={0}>
        <text fg={loadColor(proc.cpu / ceiling)}>{pad(pct(proc.cpu), 6)}</text>
      </box>
      <box width={7} flexShrink={0}>
        <text fg={theme.fgDim}>{pad(gb(proc.rssMb), 6)}</text>
      </box>
      <box flexGrow={1} flexShrink={1} overflow="hidden">
        <text fg={theme.fg} wrapMode="none" truncate>
          {shortCommand(proc.command, 200)}
        </text>
      </box>
      {proc.session ? (
        <box width={26} flexShrink={0} overflow="hidden">
          <text fg={theme.accentAlt} wrapMode="none" truncate>
            {"  "}
            {proc.session}
          </text>
        </box>
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
            trailing={`${pct(snapshot.systemCpu)} of ${pct(ceiling)} · ${snapshot.cores} cores`}
          />
          <MeterRow
            label="cpu (wt)"
            value={snapshot.wtCpu}
            max={ceiling}
            trailing={`${pct(snapshot.wtCpu)} · ${gb(snapshot.wtRssMb)} rss`}
          />
          <MeterRow
            label="memory"
            value={snapshot.memUsedMb}
            max={snapshot.memTotalMb}
            trailing={`${gb(snapshot.memUsedMb)} of ${gb(snapshot.memTotalMb)}`}
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
              trailing={`${pad(pct(b.cpu), 5)}  ${pad(gb(b.rssMb), 6)}  ${b.count} proc${b.count === 1 ? "" : "s"}`}
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
                  label={s.name.slice(0, LABEL_W - 1)}
                  value={s.cpu}
                  max={ceiling}
                  trailing={`${pad(pct(s.cpu), 5)}  ${pad(gb(s.rssMb), 6)}  ${s.summary}`}
                />
              ))}
            </box>
          </>
        ) : null}

        <SectionHeader
          title="heaviest processes downstream of wt"
          note="%cpu is a lifetime decaying average, not an instantaneous sample — read it as sustained pressure."
        />
        <box flexDirection="column">
          {snapshot.top.map((p) => (
            <ProcRow key={p.pid} proc={p} ceiling={ceiling} />
          ))}
        </box>

        <SectionHeader
          title="heaviest processes NOT downstream of wt"
          note="if the answer to 'why is my machine slow' is here, it isn't wt or the agents."
        />
        <box flexDirection="column">
          {snapshot.outsiders.map((p) => (
            <ProcRow key={p.pid} proc={p} ceiling={ceiling} />
          ))}
        </box>
      </scrollbox>
    </Modal>
  );
}
