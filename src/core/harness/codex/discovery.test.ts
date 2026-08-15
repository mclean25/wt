import { describe, expect, test } from "bun:test";

import {
  CodexDiscoveryClient,
  type CodexDiscoveryWorker,
} from "./discovery.ts";
import type {
  CodexDiscoveryRequest,
  CodexDiscoveryResult,
} from "./discovery-protocol.ts";

class FakeWorker implements CodexDiscoveryWorker {
  readonly posted: CodexDiscoveryRequest[] = [];
  terminated = false;
  unrefed = false;

  private readonly messageListeners: Array<(event: MessageEvent) => void> = [];
  private readonly errorListeners: Array<(event: ErrorEvent) => void> = [];
  private readonly closeListeners: Array<(event: Event) => void> = [];

  postMessage(message: CodexDiscoveryRequest): void {
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

  reply(message: CodexDiscoveryResult): void {
    const event = { data: message } as MessageEvent;
    for (const listener of this.messageListeners) listener(event);
  }

  fail(message: string): void {
    const event = { message } as ErrorEvent;
    for (const listener of this.errorListeners) listener(event);
  }
}

function clientWith(worker: FakeWorker): CodexDiscoveryClient {
  return new CodexDiscoveryClient(() => worker);
}

describe("CodexDiscoveryClient", () => {
  test("serializes scans through one worker", async () => {
    const worker = new FakeWorker();
    const client = clientWith(worker);

    const first = client.discover("one", "/one");
    const second = client.discover("two", "/two");

    expect(worker.unrefed).toBe(true);
    expect(worker.posted.map((message) => message.slug)).toEqual(["one"]);

    worker.reply({ type: "result", id: worker.posted[0]!.id, sessions: [] });
    await expect(first).resolves.toEqual([]);
    expect(worker.posted.map((message) => message.slug)).toEqual(["one", "two"]);

    worker.reply({ type: "result", id: worker.posted[1]!.id, sessions: [] });
    await expect(second).resolves.toEqual([]);
    client.dispose();
  });

  test("removes an aborted queued scan before dispatch", async () => {
    const worker = new FakeWorker();
    const client = clientWith(worker);
    const controller = new AbortController();

    const first = client.discover("one", "/one");
    const obsolete = client.discover("obsolete", "/obsolete", controller.signal);
    controller.abort();

    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    worker.reply({ type: "result", id: worker.posted[0]!.id, sessions: [] });
    await expect(first).resolves.toEqual([]);
    expect(worker.posted.map((message) => message.slug)).toEqual(["one"]);
    client.dispose();
  });

  test("lets an aborted active scan finish before dispatching the next one", async () => {
    const worker = new FakeWorker();
    const client = clientWith(worker);
    const controller = new AbortController();

    const obsolete = client.discover("obsolete", "/obsolete", controller.signal);
    const next = client.discover("next", "/next");
    controller.abort();

    await expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    expect(worker.posted.map((message) => message.slug)).toEqual(["obsolete"]);

    worker.reply({ type: "result", id: worker.posted[0]!.id, sessions: [] });
    expect(worker.posted.map((message) => message.slug)).toEqual([
      "obsolete",
      "next",
    ]);
    worker.reply({ type: "result", id: worker.posted[1]!.id, sessions: [] });
    await expect(next).resolves.toEqual([]);
    client.dispose();
  });

  test("rejects active and queued scans if the worker dies", async () => {
    const worker = new FakeWorker();
    const client = clientWith(worker);

    const first = client.discover("one", "/one");
    const second = client.discover("two", "/two");
    worker.fail("boom");

    await expect(first).rejects.toThrow("codex discovery worker died (boom)");
    await expect(second).rejects.toThrow("codex discovery worker died (boom)");
    expect(worker.terminated).toBe(true);
  });

  test("dispose aborts pending work and prevents respawn", async () => {
    const worker = new FakeWorker();
    const client = clientWith(worker);
    const first = client.discover("one", "/one");
    const second = client.discover("two", "/two");

    client.dispose();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.discover("three", "/three")).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(worker.terminated).toBe(true);
  });
});
