import { describe, expect, test } from "bun:test";

import type {
  CodexTailWorkerMessage,
  CodexTailWorkerResult,
} from "./codex/tail-protocol.ts";
import {
  HarnessTailRegistry,
  harnessTailKey,
  type CodexTailWorker,
} from "./tail.ts";

class FakeTailWorker implements CodexTailWorker {
  readonly posted: CodexTailWorkerMessage[] = [];
  terminated = false;
  unrefed = false;

  private readonly messageListeners: Array<(event: MessageEvent) => void> = [];
  private readonly errorListeners: Array<(event: ErrorEvent) => void> = [];
  private readonly closeListeners: Array<(event: Event) => void> = [];

  postMessage(message: CodexTailWorkerMessage): void {
    this.posted.push(message);
  }

  addEventListener(
    type: "message" | "error" | "close",
    listener:
      | ((event: MessageEvent) => void)
      | ((event: ErrorEvent) => void)
      | ((event: Event) => void),
  ): void {
    if (type === "message") {
      this.messageListeners.push(listener as (event: MessageEvent) => void);
    } else if (type === "error") {
      this.errorListeners.push(listener as (event: ErrorEvent) => void);
    } else {
      this.closeListeners.push(listener as (event: Event) => void);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  unref(): void {
    this.unrefed = true;
  }

  reply(result: CodexTailWorkerResult): void {
    const event = { data: result } as MessageEvent;
    for (const listener of this.messageListeners) listener(event);
  }
}

function pumpMessages(worker: FakeTailWorker) {
  return worker.posted.filter(
    (message): message is Extract<CodexTailWorkerMessage, { type: "pump" }> =>
      message.type === "pump",
  );
}

describe("HarnessTailRegistry Codex worker boundary", () => {
  test("seeds a Codex slot by posting work instead of pumping inline", () => {
    const worker = new FakeTailWorker();
    const registry = new HarnessTailRegistry(() => worker);

    registry.ensure("alpha", "/alpha", "codex");

    expect(worker.unrefed).toBe(true);
    expect(pumpMessages(worker)).toEqual([
      {
        type: "pump",
        id: 1,
        slots: [
          {
            key: harnessTailKey("alpha", "codex"),
            slug: "alpha",
            wtPath: "/alpha",
          },
        ],
      },
    ]);
    registry.stopAll();
    expect(worker.terminated).toBe(true);
  });

  test("applies worker lines to the matching registry entry", () => {
    const worker = new FakeTailWorker();
    const registry = new HarnessTailRegistry(() => worker);
    const key = harnessTailKey("alpha", "codex");
    registry.ensure("alpha", "/alpha", "codex");

    worker.reply({
      type: "result",
      id: pumpMessages(worker)[0]!.id,
      updates: [
        {
          key,
          lines: [{ id: 1, ts: 123, kind: "assistant", text: "done" }],
        },
      ],
      errors: [],
    });

    expect(registry.getSnapshot().get(key)?.lines).toEqual([
      { id: 1, ts: 123, kind: "assistant", text: "done" },
    ]);
    registry.stopAll();
  });

  test("coalesces changes during an in-flight pump into one follow-up", () => {
    const worker = new FakeTailWorker();
    const registry = new HarnessTailRegistry(() => worker);
    registry.ensure("alpha", "/alpha", "codex");
    registry.ensure("beta", "/beta", "codex");

    expect(pumpMessages(worker)).toHaveLength(1);
    worker.reply({
      type: "result",
      id: pumpMessages(worker)[0]!.id,
      updates: [],
      errors: [],
    });

    const pumps = pumpMessages(worker);
    expect(pumps).toHaveLength(2);
    expect(pumps[1]!.slots.map((slot) => slot.slug)).toEqual(["alpha", "beta"]);
    registry.stopAll();
  });

  test("drops a late worker update after its slot stops", () => {
    const worker = new FakeTailWorker();
    const registry = new HarnessTailRegistry(() => worker);
    const key = harnessTailKey("alpha", "codex");
    registry.ensure("alpha", "/alpha", "codex");
    const request = pumpMessages(worker)[0]!;

    registry.stop("alpha", "codex");
    worker.reply({
      type: "result",
      id: request.id,
      updates: [
        {
          key,
          lines: [{ id: 1, ts: 123, kind: "assistant", text: "stale" }],
        },
      ],
      errors: [],
    });

    expect(registry.getSnapshot().has(key)).toBe(false);
    registry.stopAll();
  });
});
