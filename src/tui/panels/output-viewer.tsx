/**
 * The bottom pane. Renders one Output at a time — events, an action
 * run, or a live claude tmux session — picked by id. Owns the
 * surrounding box / border / title; defers to the per-kind content
 * components for the body.
 */
import { actionRegistry } from "../../core/actions.ts";
import { eventsOutputId, type Output, outputStatusLabel } from "../../core/outputs.ts";
import { theme } from "../theme.ts";
import { truncateEnd } from "../text.ts";

import {
  ActionContent,
  HarnessSessionContent,
  SessionContent,
  ShellContent,
} from "./action-viewer.tsx";
import { ActivityContent, DestroyContent } from "./activity.tsx";

type Props = {
  output: Output;
  height: number;
  /** Actual pane width, which can be only the right column of the terminal. */
  width: number;
};

function borderColor(o: Output): string {
  if (o.kind === "events") return theme.border;
  if (o.kind === "session") return theme.info;
  // Destroy borrows the warn palette — it's a destructive op in
  // flight, distinct from a benign action's running cyan.
  if (o.kind === "destroy") return theme.warn;
  switch (o.status) {
    case "running":
      return theme.accent;
    case "done":
      return theme.ok;
    case "killed":
      return theme.warn;
    case "failed":
      return theme.err;
    default:
      return theme.border;
  }
}
function titleFor(o: Output, width: number): string {
  if (o.kind === "events" || o.kind === "session") return truncateEnd(o.title, width);
  const killHint = o.status === "running" ? " · ! kill" : "";
  const status = o.kind === "destroy" ? "running" : `${outputStatusLabel(o.status)}${killHint}`;
  const suffix = ` · ${status}`;
  // Keep the outcome visible when a long task or session name fills the
  // border. Native box titles disappear completely when they do not fit.
  if (Bun.stringWidth(suffix) >= width) return truncateEnd(status, width);
  const label = o.kind === "destroy" ? `destroy · ${o.slug ?? "?"}` : `action · ${o.title}`;
  return `${truncateEnd(label, width - Bun.stringWidth(suffix))}${suffix}`;
}

export function OutputViewer({ output, height, width }: Props) {
  const title = ` ${titleFor(output, Math.max(0, width - 8))} `;
  return (
    <box
      flexShrink={0}
      height={height}
      width={width}
      border
      borderStyle="single"
      borderColor={borderColor(output)}
      title={title}
      titleAlignment="left"
      flexDirection="column"
      overflow="hidden"
      paddingLeft={1}
      paddingRight={1}
    >
      <OutputContent output={output} height={height} width={width} />
    </box>
  );
}

function OutputContent({ output, height, width }: Props) {
  if (output.kind === "events") {
    return (
      <ActivityContent
        feed={output.id === eventsOutputId() ? "attention" : "firehose"}
        width={width}
      />
    );
  }
  if (output.kind === "destroy" && output.slug) {
    return <DestroyContent slug={output.slug} width={width} />;
  }
  if (output.kind === "session" && output.slug) {
    // Both claude and shell tail their tmux pane: claude reads
    // stream-json from the wt-managed jsonl, shell reads the
    // pipe-pane log with ANSI stripped. Different parsers, same
    // shape downstream.
    if (output.sessionKind === "claude") {
      return (
        <SessionContent
          slug={output.slug}
          name={output.sessionName}
          height={height}
        />
      );
    }
    if (output.sessionKind === "shell") {
      return <ShellContent slug={output.slug} height={height} />;
    }
    if (output.sessionKind === "codex" || output.sessionKind === "opencode") {
      return (
        <HarnessSessionContent
          slug={output.slug}
          harnessId={output.sessionKind}
          height={height}
        />
      );
    }
  }
  if (output.kind === "action" && output.slug) {
    // Both `outputs` (the picker source) and this lookup read from
    // the same `actionRegistry` map. The id is keyed on
    // `${slug}:${startedAt}`, so an entry that's in the picker is
    // always findable here. The `null` return is a defensive fallback
    // for the intra-render-mutation race window only.
    const run = actionRegistry.get(output.slug);
    if (run && run.startedAt === output.startedAt) {
      return <ActionContent run={run} height={height} />;
    }
  }
  return null;
}
