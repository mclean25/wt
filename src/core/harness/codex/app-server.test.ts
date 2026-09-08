import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Fiber } from "effect";

import {
  CodexAppServerError,
  CodexAppServerTransportError,
  type CodexAppServerDependencies,
  type CodexAppServerTransport,
  defaultCodexAppServerDependencies,
  queueCodexMessage,
  readCodexAppServerInfo,
  readCodexNativeSnapshots,
} from "./app-server.ts";

const THREAD_ID = "123e4567-e89b-12d3-a456-426614174000";
const CLIENT_ID = "0199-test-client-message";
const dirs: string[] = [];
const servers: { stop(closeActiveConnections?: boolean): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Request = { id: number; method: string; params: Record<string, unknown> };

function initializedResult() {
  return {
    userAgent: "codex_cli_rs/0.153.4",
    codexHome: "/tmp/codex-home",
    platformFamily: "unix",
    platformOs: "macos",
  };
}

function submission() {
  return {
    id: "queued-submission-id",
    input: [{ type: "text", text: "do the thing", text_elements: [] }],
    clientUserMessageId: CLIENT_ID,
  };
}

function fakeDependencies(
  connect: CodexAppServerDependencies["connect"],
): CodexAppServerDependencies {
  return {
    connect,
    socketPath: () => "/tmp/fake-codex.sock",
    clientVersion: "test",
    newClientUserMessageId: () => CLIENT_ID,
  };
}

function fakeTransport(
  handle: (request: Request) => unknown | Promise<unknown>,
  events: string[] = [],
): CodexAppServerTransport {
  let id = 0;
  return {
    request(method, params) {
      events.push(`request:${method}`);
      return Promise.resolve(handle({ id: ++id, method, params }));
    },
    notify(method) {
      events.push(`notify:${method}`);
      return Promise.resolve();
    },
    close() {
      events.push("close");
    },
  };
}

describe("Codex app-server queue API", () => {
  test("initializes, queues, starts, and releases in protocol order", async () => {
    const events: string[] = [];
    const requests: Request[] = [];
    const dependencies = fakeDependencies(async () => fakeTransport((request) => {
      requests.push(request);
      if (request.method === "initialize") return initializedResult();
      if (request.method === "thread/queue/add") return { queuedSubmission: submission() };
      if (request.method === "thread/queue/start") return { turn: { id: "turn-id" } };
      throw new Error(`unexpected ${request.method}`);
    }, events));

    const result = await Effect.runPromise(queueCodexMessage({
      threadId: THREAD_ID,
      text: "do the thing",
    }, dependencies));

    expect(result).toEqual({ submission: submission(), state: "started", reconciled: false });
    expect(events).toEqual([
      "request:initialize",
      "notify:initialized",
      "request:thread/queue/add",
      "request:thread/queue/start",
      "close",
    ]);
    expect(requests[0]?.params).toEqual({
      clientInfo: { name: "wt", title: "wt", version: "test" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    expect(requests[1]?.params).toEqual({
      threadId: THREAD_ID,
      input: [{ type: "text", text: "do the thing", text_elements: [] }],
      clientUserMessageId: CLIENT_ID,
    });
    expect(requests[2]?.params).toEqual({
      threadId: THREAD_ID,
      queuedSubmissionId: "queued-submission-id",
    });
  });

  test("a busy thread stays safely queued", async () => {
    const transport = fakeTransport((request) => {
      if (request.method === "initialize") return initializedResult();
      if (request.method === "thread/queue/add") return { queuedSubmission: submission() };
      if (request.method === "thread/queue/start") {
        throw Object.assign(new Error("thread already has an active or pending turn"), { code: -32_600 });
      }
      throw new Error(`unexpected ${request.method}`);
    });
    // Fakes cannot construct the private JSON-RPC response error, so model a
    // real response rejection with a transport that returns the public error.
    const originalRequest = transport.request;
    transport.request = async (method, params, signal) => {
      if (method === "thread/queue/start") {
        throw new CodexAppServerError({
          operation: "queue-start",
          kind: "rejected",
          detail: "thread already has an active or pending turn",
          code: -32_600,
        });
      }
      return originalRequest(method, params, signal);
    };

    const result = await Effect.runPromise(queueCodexMessage({
      threadId: THREAD_ID,
      text: "do the thing",
    }, fakeDependencies(async () => transport)));

    expect(result.state).toBe("queued");
  });

  test("never loses a durable add receipt when queue/start is unsupported", async () => {
    const transport = fakeTransport((request) => {
      if (request.method === "initialize") return initializedResult();
      if (request.method === "thread/queue/add") return { queuedSubmission: submission() };
      throw new Error(`unexpected ${request.method}`);
    });
    const originalRequest = transport.request;
    transport.request = async (method, params, signal) => {
      if (method === "thread/queue/start") {
        throw new CodexAppServerError({
          operation: "queue-start",
          kind: "unsupported",
          detail: "thread/queue/start requires a newer daemon",
          code: -32_601,
        });
      }
      return originalRequest(method, params, signal);
    };

    const result = await Effect.runPromise(queueCodexMessage({
      threadId: THREAD_ID,
      text: "do the thing",
    }, fakeDependencies(async () => transport)));

    expect(result).toEqual({ submission: submission(), state: "queued-or-started", reconciled: false });
  });

  test("an idle auto-dispatch between add and start remains accepted", async () => {
    const transport = fakeTransport((request) => {
      if (request.method === "initialize") return initializedResult();
      if (request.method === "thread/queue/add") return { queuedSubmission: submission() };
      throw new Error(`unexpected ${request.method}`);
    });
    const originalRequest = transport.request;
    transport.request = async (method, params, signal) => {
      if (method === "thread/queue/start") {
        throw new CodexAppServerError({
          operation: "queue-start",
          kind: "rejected",
          detail: "queued submission not found: queued-submission-id",
          code: -32_600,
        });
      }
      return originalRequest(method, params, signal);
    };

    const result = await Effect.runPromise(queueCodexMessage({
      threadId: THREAD_ID,
      text: "do the thing",
    }, fakeDependencies(async () => transport)));

    expect(result.state).toBe("queued-or-started");
  });

  test("a cold TUI attach race leaves the accepted message queued", async () => {
    const transport = fakeTransport((request) => {
      if (request.method === "initialize") return initializedResult();
      if (request.method === "thread/queue/add") return { queuedSubmission: submission() };
      throw new Error(`unexpected ${request.method}`);
    });
    const originalRequest = transport.request;
    transport.request = async (method, params, signal) => {
      if (method === "thread/queue/start") {
        throw new CodexAppServerError({
          operation: "queue-start",
          kind: "rejected",
          detail: "resume the thread before starting a queued message",
          code: -32_600,
        });
      }
      return originalRequest(method, params, signal);
    };

    const result = await Effect.runPromise(queueCodexMessage({
      threadId: THREAD_ID,
      text: "do the thing",
    }, fakeDependencies(async () => transport)));

    expect(result.state).toBe("queued");
  });

  test("reconnects and reconciles an ambiguous add without submitting twice", async () => {
    const calls: string[] = [];
    let connection = 0;
    const dependencies = fakeDependencies(async () => {
      connection += 1;
      return fakeTransport((request) => {
        calls.push(`${connection}:${request.method}`);
        if (request.method === "initialize") return initializedResult();
        if (connection === 1 && request.method === "thread/queue/add") {
          throw new CodexAppServerTransportError("socket closed after write", true);
        }
        if (request.method === "thread/queue/list") {
          return { data: [submission()], nextCursor: null };
        }
        if (request.method === "thread/queue/start") return { turn: { id: "turn-id" } };
        throw new Error(`unexpected ${request.method}`);
      });
    });

    const result = await Effect.runPromise(queueCodexMessage({
      threadId: THREAD_ID,
      text: "do the thing",
    }, dependencies));

    expect(result).toEqual({ submission: submission(), state: "started", reconciled: true });
    expect(connection).toBe(2);
    expect(calls.filter((call) => call.endsWith("thread/queue/add"))).toHaveLength(1);
    expect(calls).toContain("2:thread/queue/list");
    expect(calls).toContain("2:thread/queue/start");
  });

  test("fails ambiguous when reconciliation cannot prove ownership", async () => {
    let addCalls = 0;
    let connection = 0;
    const dependencies = fakeDependencies(async () => {
      connection += 1;
      return fakeTransport((request) => {
        if (request.method === "initialize") return initializedResult();
        if (request.method === "thread/queue/add") {
          addCalls += 1;
          throw new CodexAppServerTransportError("socket closed after write", true);
        }
        if (request.method === "thread/queue/list") return { data: [], nextCursor: null };
        if (request.method === "thread/items/list") {
          return { data: [], nextCursor: null, backwardsCursor: null };
        }
        throw new Error(`unexpected ${request.method}`);
      });
    });

    const error = await Effect.runPromise(queueCodexMessage({
      threadId: THREAD_ID,
      text: "do the thing",
    }, dependencies).pipe(Effect.flip));

    expect(error).toBeInstanceOf(CodexAppServerError);
    expect(error).toMatchObject({ operation: "queue-add", kind: "ambiguous" });
    expect(error.message).toContain("will not submit it again");
    expect(addCalls).toBe(1);
    expect(connection).toBe(2);
  });

  test("reconciles from recent user items when the daemon already started it", async () => {
    let connection = 0;
    let startCalls = 0;
    const dependencies = fakeDependencies(async () => {
      connection += 1;
      return fakeTransport((request) => {
        if (request.method === "initialize") return initializedResult();
        if (connection === 1 && request.method === "thread/queue/add") {
          throw new CodexAppServerTransportError("reply lost after write", true);
        }
        if (request.method === "thread/queue/list") return { data: [], nextCursor: null };
        if (request.method === "thread/items/list") {
          return {
            data: [{
              turnId: "turn-id",
              item: {
                type: "userMessage",
                id: "user-item-id",
                clientId: CLIENT_ID,
                content: submission().input,
              },
            }],
            nextCursor: null,
            backwardsCursor: null,
          };
        }
        if (request.method === "thread/queue/start") {
          startCalls += 1;
          return { turn: { id: "turn-id" } };
        }
        throw new Error(`unexpected ${request.method}`);
      });
    });

    const result = await Effect.runPromise(queueCodexMessage({
      threadId: THREAD_ID,
      text: "do the thing",
    }, dependencies));

    expect(result).toEqual({
      submission: {
        id: "user-item-id",
        input: submission().input,
        clientUserMessageId: CLIENT_ID,
      },
      state: "started",
      reconciled: true,
    });
    expect(connection).toBe(2);
    expect(startCalls).toBe(0);
  });

  test("interruption releases an in-flight connection", async () => {
    let closed = false;
    const dependencies = fakeDependencies(async () => ({
      request(method) {
        if (method === "initialize") return Promise.resolve(initializedResult());
        // @effect-diagnostics-next-line effect/newPromise:off -- deliberately unresolved fake transport used to verify scope interruption
        return new Promise<never>(() => {});
      },
      notify() { return Promise.resolve(); },
      close() { closed = true; },
    }));
    const fiber = Effect.runFork(queueCodexMessage({
      threadId: THREAD_ID,
      text: "do the thing",
    }, dependencies));

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(closed).toBeTrue();
  });

  test("reads native status and queue counts for UUIDs on one connection", async () => {
    let connections = 0;
    const calls: Request[] = [];
    const dependencies = fakeDependencies(async () => {
      connections += 1;
      return fakeTransport((request) => {
        calls.push(request);
        if (request.method === "initialize") return initializedResult();
        if (request.method === "thread/read") {
          return {
            thread: {
              status: request.params.threadId === "uuid-question"
                ? { type: "active", activeFlags: ["waitingOnUserInput"] }
                : { type: "idle" },
            },
          };
        }
        if (request.method === "thread/queue/list") {
          return {
            data: request.params.threadId === "uuid-question" ? [submission()] : [],
            nextCursor: null,
          };
        }
        throw new Error(`unexpected ${request.method}`);
      });
    });

    const snapshots = await Effect.runPromise(readCodexNativeSnapshots(
      ["uuid-question", "uuid-idle", "uuid-question"],
      dependencies,
    ));

    expect(connections).toBe(1);
    expect(snapshots).toEqual(new Map([
      ["uuid-question", {
        status: { type: "active", activeFlags: ["waitingOnUserInput"] },
        queued: 1,
      }],
      ["uuid-idle", { status: { type: "idle" }, queued: 0 }],
    ]));
    expect(calls.filter((call) => call.method === "thread/read")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "thread/queue/list")).toHaveLength(2);
    expect(calls.find((call) => call.method === "thread/read")?.params).toMatchObject({
      includeTurns: false,
    });
  });

  test("fails the native snapshot batch on malformed status", async () => {
    const dependencies = fakeDependencies(async () => fakeTransport((request) => {
      if (request.method === "initialize") return initializedResult();
      if (request.method === "thread/read") {
        return { thread: { status: { type: "active", activeFlags: "asking" } } };
      }
      if (request.method === "thread/queue/list") return { data: [], nextCursor: null };
      throw new Error(`unexpected ${request.method}`);
    }));

    const error = await Effect.runPromise(readCodexNativeSnapshots(
      ["uuid-bad"],
      dependencies,
    ).pipe(Effect.flip));

    expect(error).toMatchObject({ operation: "thread-read", kind: "protocol" });
  });
});

/** Unmask one complete client frame. */
function readClientFrame(buffer: Buffer): { text: string; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const masked = (buffer[1]! & 0x80) !== 0;
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  const mask = buffer.subarray(offset, offset + maskLength);
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
  if (masked) {
    for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i & 3]!;
  }
  return { text: payload.toString("utf8"), rest: buffer.subarray(offset + maskLength + length) };
}

function serverFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

test("real Unix WebSocket initializes, ignores notifications, queues, and starts", async () => {
  const dir = mkdtempSync("/tmp/wt-codex-app-server-");
  dirs.push(dir);
  const path = join(dir, "app-server-control.sock");
  const received: Record<string, unknown>[] = [];
  let rejectQueueAdd = false;
  const server = Bun.listen<{ buffer: Buffer; upgraded: boolean }>({
    unix: path,
    socket: {
      open(socket) { socket.data = { buffer: Buffer.alloc(0), upgraded: false }; },
      data(socket, chunk) {
        socket.data.buffer = Buffer.concat([socket.data.buffer, Buffer.from(chunk)]);
        if (!socket.data.upgraded) {
          const headerEnd = socket.data.buffer.indexOf("\r\n\r\n");
          if (headerEnd === -1) return;
          const head = socket.data.buffer.subarray(0, headerEnd).toString("latin1");
          expect(head.split("\r\n")[0]).toBe("GET /rpc HTTP/1.1");
          const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1] ?? "";
          const accept = createHash("sha1")
            .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest("base64");
          socket.write(Buffer.from(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
          ));
          socket.data.upgraded = true;
          socket.data.buffer = socket.data.buffer.subarray(headerEnd + 4);
        }
        for (;;) {
          const frame = readClientFrame(socket.data.buffer);
          if (!frame) return;
          socket.data.buffer = frame.rest;
          const message = JSON.parse(frame.text) as Record<string, unknown>;
          received.push(message);
          if (typeof message.id !== "number") continue;
          // An unrelated notification before every response proves response
          // routing is by id rather than by arrival position.
          socket.write(serverFrame({ method: "thread/status/changed", params: { threadId: THREAD_ID } }));
          if (message.method === "thread/queue/add" && rejectQueueAdd) {
            socket.write(serverFrame({
              id: message.id,
              error: {
                code: -32_600,
                message: "thread/queue/add requires experimentalApi capability",
              },
            }));
            continue;
          }
          const result = message.method === "initialize"
            ? initializedResult()
            : message.method === "thread/queue/add"
              ? { queuedSubmission: submission() }
              : message.method === "thread/queue/start"
                ? { turn: { id: "turn-id" } }
                : {};
          socket.write(serverFrame({ id: message.id, result }));
        }
      },
    },
  });
  servers.push(server);
  const dependencies: CodexAppServerDependencies = {
    ...defaultCodexAppServerDependencies,
    socketPath: () => path,
    clientVersion: "test",
  };

  const info = await Effect.runPromise(readCodexAppServerInfo(dependencies));
  const delivery = await Effect.runPromise(queueCodexMessage({
    threadId: THREAD_ID,
    text: "do the thing",
  }, dependencies));
  rejectQueueAdd = true;
  const unsupported = await Effect.runPromise(queueCodexMessage({
    threadId: THREAD_ID,
    text: "unsupported on old daemon",
  }, dependencies).pipe(Effect.flip));
  await Bun.sleep(10);

  expect(info).toEqual(initializedResult());
  expect(delivery).toEqual({ submission: submission(), state: "started", reconciled: false });
  expect(unsupported).toMatchObject({ operation: "queue-add", kind: "unsupported" });
  expect(received.map((message) => message.method)).toEqual([
    "initialize",
    "initialized",
    "initialize",
    "initialized",
    "thread/queue/add",
    "thread/queue/start",
    "initialize",
    "initialized",
    "thread/queue/add",
  ]);
  expect(received[0]?.params).toMatchObject({
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
});
