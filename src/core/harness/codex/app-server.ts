import { createHash, randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Data, Effect, Result } from "effect";
import type { CodexNativeThreadSnapshot, CodexThreadStatus } from "./native-status.ts";

const UPGRADE_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BUFFER_BYTES = 128 * 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const BUSY_MESSAGE = "thread already has an active or pending turn";

export type CodexQueueSubmission = {
  readonly id: string;
  readonly input: readonly unknown[];
  readonly clientUserMessageId: string;
};

export type CodexQueuePage = {
  readonly data: readonly CodexQueueSubmission[];
  readonly nextCursor: string | null;
};

export type CodexAppServerInfo = {
  readonly userAgent: string;
  readonly codexHome: string;
  readonly platformFamily?: string;
  readonly platformOs?: string;
};

export type CodexQueueDelivery = {
  readonly submission: CodexQueueSubmission;
  readonly state: "started" | "queued" | "queued-or-started";
  readonly reconciled: boolean;
};

export type CodexAppServerFailureKind =
  | "absent"
  | "unavailable"
  | "unsupported"
  | "protocol"
  | "rejected"
  | "ambiguous";

export class CodexAppServerError extends Data.TaggedError("CodexAppServerError")<{
  readonly operation: "connect" | "initialize" | "queue-add" | "queue-list" | "queue-start" | "thread-items" | "thread-read";
  readonly kind: CodexAppServerFailureKind;
  readonly detail: string;
  readonly code?: number;
  readonly cause?: unknown;
}> {
  override get message(): string {
    return this.detail;
  }
}

export type CodexAppServerTransport = {
  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): Promise<void>;
  close(): void;
};

export type CodexAppServerDependencies = {
  readonly connect: (socketPath: string, signal?: AbortSignal) => Promise<CodexAppServerTransport>;
  readonly socketPath: () => string;
  readonly clientVersion: string;
  readonly newClientUserMessageId: () => string;
};

export class CodexAppServerTransportError extends Error {
  constructor(
    message: string,
    readonly postWrite: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

class RpcResponseError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type PendingRequest = {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  wrote: boolean;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
  frame?: OutboundFrame;
};

type OutboundFrame = {
  readonly data: Buffer;
  offset: number;
  readonly onFirstWrite?: () => void;
  readonly onComplete?: () => void;
  readonly onFailure?: (error: Error) => void;
};

function expectedAccept(key: string): string {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

function maskFrame(payload: Buffer, opcode = 0x1): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(length);
  for (let i = 0; i < length; i += 1) masked[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([header, mask, masked]);
}

function textFrame(value: unknown): Buffer {
  return maskFrame(Buffer.from(JSON.stringify(value), "utf8"));
}

/** Minimal RFC 6455 JSON-RPC transport over Codex's Unix control socket. */
async function connectUnixWebSocket(
  socketPath: string,
  signal?: AbortSignal,
): Promise<CodexAppServerTransport> {
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let nextId = 1;
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  let fragmentOpcode: number | null = null;
  let dead: Error | null = null;
  const requests = new Map<number, PendingRequest>();
  const outbound: OutboundFrame[] = [];
  type Socket = { write(data: Uint8Array): number; end(): void };
  let socket: Socket | null = null;
  let rawSocket: Socket | null = null;
  const key = randomBytes(16).toString("base64");

  const failAll = (error: Error): void => {
    if (!dead) dead = error;
    for (const pending of requests.values()) {
      clearTimeout(pending.timer);
      pending.abort?.();
      pending.reject(
        error instanceof CodexAppServerTransportError
          ? new CodexAppServerTransportError(error.message, pending.wrote, error.cause)
          : new CodexAppServerTransportError(error.message, pending.wrote, error),
      );
    }
    requests.clear();
    for (const frame of outbound.splice(0)) frame.onFailure?.(error);
  };

  const flush = (): void => {
    const activeSocket = socket ?? rawSocket;
    if (!activeSocket) return;
    while (outbound.length > 0) {
      const frame = outbound[0]!;
      const wrote = activeSocket.write(frame.data.subarray(frame.offset));
      if (wrote <= 0) return;
      if (frame.offset === 0) frame.onFirstWrite?.();
      frame.offset += wrote;
      if (frame.offset < frame.data.length) return;
      outbound.shift();
      frame.onComplete?.();
    }
  };

  const send = (
    data: Buffer,
    onFirstWrite?: () => void,
    onComplete?: () => void,
    onFailure?: (error: Error) => void,
  ): OutboundFrame => {
    if (dead) throw dead;
    if (!(socket ?? rawSocket)) throw new CodexAppServerTransportError("Codex app-server socket is not open", false);
    const frame: OutboundFrame = { data, offset: 0, onFirstWrite, onComplete, onFailure };
    outbound.push(frame);
    flush();
    return frame;
  };

  const cancelUnwrittenFrame = (pending: PendingRequest): void => {
    if (pending.wrote || !pending.frame || pending.frame.offset !== 0) return;
    const index = outbound.indexOf(pending.frame);
    if (index !== -1) outbound.splice(index, 1);
  };

  const dispatchText = (text: string): void => {
    let message: { id?: number; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = requests.get(message.id);
    if (!pending) return;
    requests.delete(message.id);
    clearTimeout(pending.timer);
    pending.abort?.();
    if (message.error) {
      pending.reject(new RpcResponseError(
        typeof message.error.code === "number" ? message.error.code : -32_603,
        message.error.message ?? "Codex app-server rejected the request",
        message.error.data,
      ));
    } else {
      pending.resolve(message.result);
    }
  };

  const parseFrames = (): void => {
    while (buffer.length >= 2) {
      const first = buffer[0]!;
      const second = buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const wideLength = buffer.readBigUInt64BE(2);
        if (wideLength > BigInt(MAX_BUFFER_BYTES)) {
          failAll(new Error("Codex app-server message exceeded the buffer cap"));
          return;
        }
        length = Number(wideLength);
        offset = 10;
      }
      if (masked) offset += 4;
      if (length > MAX_BUFFER_BYTES || buffer.length < offset + length) return;
      let payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) {
        const mask = buffer.subarray(offset - 4, offset);
        for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i & 3]!;
      }
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) {
        try { send(maskFrame(Buffer.alloc(0), 0x8)); } catch { /* peer is already closing */ }
        failAll(new Error("Codex app-server closed the connection"));
        return;
      }
      if (opcode === 0x9) {
        try { send(maskFrame(payload, 0xa)); } catch { /* best-effort pong */ }
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode !== 0x0 && opcode !== 0x1) continue;
      if (opcode === 0x1) {
        fragments = [];
        fragmentBytes = 0;
        fragmentOpcode = opcode;
      } else if (fragmentOpcode === null) {
        failAll(new Error("Codex app-server sent an unexpected continuation frame"));
        return;
      }
      fragments.push(payload);
      fragmentBytes += payload.length;
      if (fragmentBytes > MAX_BUFFER_BYTES) {
        failAll(new Error("Codex app-server message exceeded the reassembly cap"));
        return;
      }
      if (fin) {
        dispatchText(Buffer.concat(fragments).toString("utf8"));
        fragments = [];
        fragmentBytes = 0;
        fragmentOpcode = null;
      }
    }
  };

  // @effect-diagnostics-next-line effect/newPromise:off -- Bun's Unix socket API is callback based
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(upgradeTimer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        try { rawSocket?.end(); } catch { /* already closed */ }
        reject(error);
      } else resolve();
    };
    const onAbort = () => finish(new CodexAppServerTransportError("Codex app-server connection interrupted", false));
    const upgradeTimer = setTimeout(
      () => finish(new CodexAppServerTransportError("Codex app-server did not complete the WebSocket upgrade", false)),
      UPGRADE_TIMEOUT_MS,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(opened) {
          rawSocket = opened;
          if (settled) {
            opened.end();
            return;
          }
          send(Buffer.from(
            "GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          ));
        },
        drain() { flush(); },
        data(opened, data) {
          buffer = Buffer.concat([buffer, Buffer.from(data)]);
          if (buffer.length > MAX_BUFFER_BYTES) {
            const error = new Error("Codex app-server response exceeded the buffer cap");
            finish(error);
            failAll(error);
            return;
          }
          if (!upgraded) {
            const headerEnd = buffer.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;
            const head = buffer.subarray(0, headerEnd).toString("latin1");
            if (!head.startsWith("HTTP/1.1 101")) {
              finish(new CodexAppServerTransportError(
                `Codex app-server refused the WebSocket upgrade: ${head.split("\r\n")[0]}`,
                false,
              ));
              return;
            }
            const accept = /^sec-websocket-accept:\s*(\S+)/im.exec(head)?.[1];
            if (accept !== expectedAccept(key)) {
              finish(new CodexAppServerTransportError("Codex app-server WebSocket accept validation failed", false));
              return;
            }
            buffer = buffer.subarray(headerEnd + 4);
            upgraded = true;
            socket = opened;
            finish();
          }
          parseFrames();
        },
        error(_opened, error) {
          const wrapped = new CodexAppServerTransportError(
            `Codex app-server socket: ${error?.message ?? String(error)}`,
            false,
            error,
          );
          finish(wrapped);
          failAll(wrapped);
        },
        close() {
          const wrapped = new CodexAppServerTransportError("Codex app-server socket closed", false);
          finish(wrapped);
          failAll(wrapped);
        },
      },
    }).catch((cause) => finish(new CodexAppServerTransportError(
      cause instanceof Error ? cause.message : String(cause),
      false,
      cause,
    )));
  });

  return {
    request(method, params, requestSignal) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      // @effect-diagnostics-next-line effect/newPromise:off -- one reply slot in the JSON-RPC transport
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          const pending = requests.get(id);
          if (!pending) return;
          requests.delete(id);
          pending.abort?.();
          cancelUnwrittenFrame(pending);
          reject(new CodexAppServerTransportError(
            `Codex app-server did not answer ${method} within ${REQUEST_TIMEOUT_MS}ms`,
            pending.wrote,
          ));
        }, REQUEST_TIMEOUT_MS);
        const pending: PendingRequest = { resolve, reject, wrote: false, timer };
        if (requestSignal) {
          const onAbort = () => {
            if (!requests.delete(id)) return;
            clearTimeout(timer);
            cancelUnwrittenFrame(pending);
            reject(new CodexAppServerTransportError(`Codex app-server ${method} interrupted`, pending.wrote));
          };
          requestSignal.addEventListener("abort", onAbort, { once: true });
          pending.abort = () => requestSignal.removeEventListener("abort", onAbort);
        }
        requests.set(id, pending);
        try {
          pending.frame = send(textFrame({ id, method, params }), () => { pending.wrote = true; });
        } catch (cause) {
          requests.delete(id);
          clearTimeout(timer);
          pending.abort?.();
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    },
    notify(method, params) {
      // @effect-diagnostics-next-line effect/newPromise:off -- resolves only once Bun accepts the complete notification frame
      return new Promise<void>((resolve, reject) => {
        try {
          send(
            textFrame({ method, ...(params === undefined ? {} : { params }) }),
            undefined,
            resolve,
            reject,
          );
        } catch (cause) {
          reject(cause);
        }
      });
    },
    close() {
      try { socket?.end(); } catch { /* already closed */ }
      failAll(new Error("Codex app-server connection closed by wt"));
    },
  };
}

export function codexAppServerSocketPath(codexHome = process.env.CODEX_HOME): string {
  return join(codexHome || join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");
}

export const defaultCodexAppServerDependencies: CodexAppServerDependencies = {
  connect: connectUnixWebSocket,
  socketPath: () => codexAppServerSocketPath(),
  clientVersion: "0.1.0",
  newClientUserMessageId: randomUUID,
};

function unsupportedResponse(error: RpcResponseError): boolean {
  return error.code === -32_601 || (
    error.code === -32_600 && (
      error.message.includes("requires experimentalApi capability") ||
      error.message.startsWith("Invalid request: unknown variant `thread/queue/")
    )
  );
}

function operationError(
  operation: CodexAppServerError["operation"],
  cause: unknown,
): CodexAppServerError {
  if (cause instanceof CodexAppServerError) return cause;
  if (cause instanceof RpcResponseError) {
    return new CodexAppServerError({
      operation,
      kind: unsupportedResponse(cause) ? "unsupported" : "rejected",
      detail: cause.message,
      code: cause.code,
      cause,
    });
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  const nestedCode = (value: unknown): string | undefined => {
    if (!(value instanceof Error)) return undefined;
    const code = (value as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
    return nestedCode(value.cause);
  };
  const absent = operation === "connect" && (
    nestedCode(cause) === "ENOENT" || /ENOENT|No such file|not found/i.test(detail)
  );
  const transport = cause instanceof CodexAppServerTransportError;
  return new CodexAppServerError({
    operation,
    kind: transport && cause.postWrite && (operation === "queue-add" || operation === "queue-start")
      ? "ambiguous"
      : absent ? "absent" : transport || operation === "connect" ? "unavailable" : "protocol",
    detail,
    cause,
  });
}

function requestEffect(
  transport: CodexAppServerTransport,
  operation: CodexAppServerError["operation"],
  method: string,
  params: Record<string, unknown>,
): Effect.Effect<unknown, CodexAppServerError> {
  return Effect.tryPromise({
    try: (signal) => transport.request(method, params, signal),
    catch: (cause) => operationError(operation, cause),
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : null;
}

function parseSubmission(value: unknown): CodexQueueSubmission | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== "string" || typeof record.clientUserMessageId !== "string" || !Array.isArray(record.input)) {
    return null;
  }
  return { id: record.id, clientUserMessageId: record.clientUserMessageId, input: record.input };
}

function protocolError(
  operation: CodexAppServerError["operation"],
  detail: string,
): CodexAppServerError {
  return new CodexAppServerError({ operation, kind: "protocol", detail });
}

export type CodexAppServerClient = {
  readonly info: CodexAppServerInfo;
  readonly queueAdd: (
    threadId: string,
    text: string,
    clientUserMessageId: string,
  ) => Effect.Effect<CodexQueueSubmission, CodexAppServerError>;
  readonly queueList: (
    threadId: string,
    options?: { readonly cursor?: string | null; readonly limit?: number },
  ) => Effect.Effect<CodexQueuePage, CodexAppServerError>;
  readonly queueStart: (
    threadId: string,
    queuedSubmissionId: string,
  ) => Effect.Effect<"started" | "queued" | "queued-or-started", CodexAppServerError>;
  readonly findRecentUserMessage: (
    threadId: string,
    clientUserMessageId: string,
  ) => Effect.Effect<CodexQueueSubmission | null, CodexAppServerError>;
  readonly threadReadStatus: (
    threadId: string,
  ) => Effect.Effect<CodexThreadStatus, CodexAppServerError>;
};

function initializeClient(
  transport: CodexAppServerTransport,
  dependencies: CodexAppServerDependencies,
): Effect.Effect<CodexAppServerClient, CodexAppServerError> {
  return Effect.gen(function* () {
    const initialized = yield* requestEffect(transport, "initialize", "initialize", {
      clientInfo: { name: "wt", title: "wt", version: dependencies.clientVersion },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const record = asRecord(initialized);
    if (!record || typeof record.userAgent !== "string" || typeof record.codexHome !== "string") {
      return yield* protocolError("initialize", "Codex app-server returned an invalid initialize response");
    }
    yield* Effect.tryPromise({
      try: () => transport.notify("initialized"),
      catch: (cause) => operationError("initialize", cause),
    });
    const info: CodexAppServerInfo = {
      userAgent: record.userAgent,
      codexHome: record.codexHome,
      ...(typeof record.platformFamily === "string" ? { platformFamily: record.platformFamily } : {}),
      ...(typeof record.platformOs === "string" ? { platformOs: record.platformOs } : {}),
    };
    return {
      info,
      queueAdd: (threadId, text, clientUserMessageId) => requestEffect(
        transport,
        "queue-add",
        "thread/queue/add",
        {
          threadId,
          input: [{ type: "text", text, text_elements: [] }],
          clientUserMessageId,
        },
      ).pipe(Effect.flatMap((result) => {
        const submission = parseSubmission(asRecord(result)?.queuedSubmission);
        return submission
          ? Effect.succeed(submission)
          : Effect.fail(protocolError("queue-add", "Codex app-server returned an invalid queue/add response"));
      })),
      queueList: (threadId, options = {}) => requestEffect(
        transport,
        "queue-list",
        "thread/queue/list",
        { threadId, cursor: options.cursor ?? null, limit: options.limit ?? 100 },
      ).pipe(Effect.flatMap((result) => {
        const page = asRecord(result);
        if (!page || !Array.isArray(page.data) || !(page.nextCursor === null || typeof page.nextCursor === "string")) {
          return Effect.fail(protocolError("queue-list", "Codex app-server returned an invalid queue/list response"));
        }
        const data = page.data.map(parseSubmission);
        return data.every((entry): entry is CodexQueueSubmission => entry !== null)
          ? Effect.succeed({ data, nextCursor: page.nextCursor })
          : Effect.fail(protocolError("queue-list", "Codex app-server returned an invalid queued submission"));
      })),
      queueStart: (threadId, queuedSubmissionId) => requestEffect(
        transport,
        "queue-start",
        "thread/queue/start",
        { threadId, queuedSubmissionId },
      ).pipe(
        Effect.as("started" as const),
        Effect.catch((error) => {
          if (error.kind === "rejected" && error.message === BUSY_MESSAGE) return Effect.succeed("queued" as const);
          if (
            error.kind === "rejected" &&
            error.message === "resume the thread before starting a queued message"
          ) {
            // The durable add won the race with a cold tmux TUI attaching to
            // the daemon. Leave it queued; loading the exact thread wakes the
            // native dispatcher without wt becoming a second subscriber.
            return Effect.succeed("queued" as const);
          }
          if (error.kind === "rejected" && error.message.startsWith("queued submission not found:")) {
            // queue/add can wake the daemon's idle dispatcher before this
            // explicit start arrives. The add receipt is durable acceptance;
            // absence here means it has already left the queue.
            return Effect.succeed("queued-or-started" as const);
          }
          if (error.kind === "ambiguous") return Effect.succeed("queued-or-started" as const);
          return Effect.fail(error);
        }),
      ),
      findRecentUserMessage: (threadId, clientUserMessageId) => requestEffect(
        transport,
        "thread-items",
        "thread/items/list",
        {
          threadId,
          turnId: null,
          cursor: null,
          limit: 100,
          sortDirection: "desc",
        },
      ).pipe(Effect.flatMap((result) => {
        const page = asRecord(result);
        if (!page || !Array.isArray(page.data)) {
          return Effect.fail(protocolError("thread-items", "Codex app-server returned an invalid thread/items/list response"));
        }
        for (const value of page.data) {
          const entry = asRecord(value);
          const item = asRecord(entry?.item);
          if (item?.type !== "userMessage" || item.clientId !== clientUserMessageId || typeof item.id !== "string") continue;
          if (!Array.isArray(item.content)) {
            return Effect.fail(protocolError("thread-items", "Codex app-server returned an invalid user message item"));
          }
          return Effect.succeed({
            id: item.id,
            input: item.content,
            clientUserMessageId,
          });
        }
        return Effect.succeed(null);
      })),
      threadReadStatus: (threadId) => requestEffect(
        transport,
        "thread-read",
        "thread/read",
        { threadId, includeTurns: false },
      ).pipe(Effect.flatMap((result) => {
        const status = asRecord(asRecord(result)?.thread)?.status;
        const record = asRecord(status);
        if (!record || typeof record.type !== "string") {
          return Effect.fail(protocolError("thread-read", "Codex app-server returned an invalid thread/read status"));
        }
        if (record.type === "active" && (
          !Array.isArray(record.activeFlags) ||
          !record.activeFlags.every((flag) => typeof flag === "string")
        )) {
          return Effect.fail(protocolError("thread-read", "Codex app-server returned invalid active thread flags"));
        }
        return Effect.succeed(record as CodexThreadStatus);
      })),
    };
  });
}

export function withCodexAppServer<A, E, R>(
  use: (client: CodexAppServerClient) => Effect.Effect<A, E, R>,
  dependencies: CodexAppServerDependencies = defaultCodexAppServerDependencies,
): Effect.Effect<A, E | CodexAppServerError, R> {
  const acquire = Effect.tryPromise({
    try: (signal) => dependencies.connect(dependencies.socketPath(), signal),
    catch: (cause) => operationError("connect", cause),
  });
  return Effect.acquireUseRelease(
    acquire,
    (transport) => initializeClient(transport, dependencies).pipe(Effect.flatMap(use)),
    (transport) => Effect.sync(() => transport.close()),
  );
}

export function readCodexAppServerInfo(
  dependencies: CodexAppServerDependencies = defaultCodexAppServerDependencies,
): Effect.Effect<CodexAppServerInfo, CodexAppServerError> {
  return withCodexAppServer((client) => Effect.succeed(client.info), dependencies);
}

export function listCodexQueue(
  threadId: string,
  dependencies: CodexAppServerDependencies = defaultCodexAppServerDependencies,
): Effect.Effect<readonly CodexQueueSubmission[], CodexAppServerError> {
  return withCodexAppServer((client) => {
    const loop = (
      cursor: string | null,
      collected: readonly CodexQueueSubmission[],
      pages: number,
    ): Effect.Effect<readonly CodexQueueSubmission[], CodexAppServerError> => {
      return client.queueList(threadId, { cursor, limit: 100 }).pipe(
        Effect.flatMap((page) => {
          const next = [...collected, ...page.data];
          if (page.nextCursor === null) return Effect.succeed(next);
          return pages >= 9
            ? Effect.fail(protocolError("queue-list", "Codex queue pagination exceeded 1,000 submissions"))
            : loop(page.nextCursor, next, pages + 1);
        }),
      );
    };
    return loop(null, [], 0);
  }, dependencies);
}

/**
 * Read every discovered thread's native state on one initialized connection.
 * The batch fails whole so callers can preserve rollout-derived state rather
 * than display a partly native, partly stale fleet as authoritative.
 */
export function readCodexNativeSnapshots(
  threadIds: readonly string[],
  dependencies: CodexAppServerDependencies = defaultCodexAppServerDependencies,
): Effect.Effect<ReadonlyMap<string, CodexNativeThreadSnapshot>, CodexAppServerError> {
  const uniqueIds = [...new Set(threadIds)];
  if (uniqueIds.length === 0) return Effect.succeed(new Map());
  return withCodexAppServer((client) => Effect.forEach(
    uniqueIds,
    (threadId) => Effect.all({
      status: client.threadReadStatus(threadId),
      queued: (() => {
        const loop = (cursor: string | null, count: number, pages: number): Effect.Effect<number, CodexAppServerError> => {
          return client.queueList(threadId, { cursor, limit: 100 }).pipe(
            Effect.flatMap((page) => {
              const next = count + page.data.length;
              if (page.nextCursor === null) return Effect.succeed(next);
              return pages >= 9
                ? Effect.fail(protocolError("queue-list", "Codex queue pagination exceeded 1,000 submissions"))
                : loop(page.nextCursor, next, pages + 1);
            }),
          );
        };
        return loop(null, 0, 0);
      })(),
    }).pipe(Effect.map((snapshot) => [threadId, snapshot] as const)),
    { concurrency: 8 },
  ).pipe(Effect.map((entries) => new Map(entries))), dependencies);
}

function reconcileSubmission(
  client: CodexAppServerClient,
  threadId: string,
  clientUserMessageId: string,
): Effect.Effect<
  { readonly submission: CodexQueueSubmission; readonly state: "queued" | "started" },
  CodexAppServerError
> {
  const loop = (
    cursor: string | null,
    pages: number,
  ): Effect.Effect<
    { readonly submission: CodexQueueSubmission; readonly state: "queued" | "started" },
    CodexAppServerError
  > => client.queueList(
    threadId,
    { cursor, limit: 100 },
  ).pipe(Effect.flatMap((page) => {
    const match = page.data.find((submission) => submission.clientUserMessageId === clientUserMessageId);
    if (match) return Effect.succeed({ submission: match, state: "queued" as const });
    if (page.nextCursor !== null && pages < 9) return loop(page.nextCursor, pages + 1);
    // An idle daemon may auto-start the queued submission before wt can
    // reconnect, removing it from queue/list. Its persisted user item keeps
    // the same client id, so this is the second and final ownership proof.
    return client.findRecentUserMessage(threadId, clientUserMessageId).pipe(
      Effect.mapError((error) => new CodexAppServerError({
        operation: "queue-add",
        kind: "ambiguous",
        detail: `Codex app-server lost the queue/add reply and could not confirm ${clientUserMessageId} in recent thread items; wt will not submit it again`,
        cause: error,
      })),
      Effect.flatMap((started) => started
        ? Effect.succeed({ submission: started, state: "started" as const })
        : Effect.fail(new CodexAppServerError({
          operation: "queue-add",
          kind: "ambiguous",
          detail: `Codex app-server lost the queue/add reply and neither queue/list nor recent thread items confirmed ${clientUserMessageId}; wt will not submit it again`,
        }))),
    );
  }));
  return loop(null, 0);
}

export function queueCodexMessage(
  args: {
    readonly threadId: string;
    readonly text: string;
    readonly clientUserMessageId?: string;
  },
  dependencies: CodexAppServerDependencies = defaultCodexAppServerDependencies,
): Effect.Effect<CodexQueueDelivery, CodexAppServerError> {
  const clientUserMessageId = args.clientUserMessageId ?? dependencies.newClientUserMessageId();
  const firstAttempt = withCodexAppServer((client) => Effect.gen(function* () {
    const added = yield* Effect.result(client.queueAdd(args.threadId, args.text, clientUserMessageId));
    if (added._tag === "Success") {
      // queue/add returning a receipt is the durable ownership boundary. A
      // later queue/start failure must never escape to a caller that could
      // fall back to terminal input and submit the same message twice. Known
      // races are classified by queueStart; any remaining definite failure
      // simply leaves the accepted submission queued for Codex to dispatch.
      const started = yield* Effect.result(client.queueStart(args.threadId, added.success.id));
      return Result.isSuccess(started)
        ? { _tag: "Delivered" as const, submission: added.success, state: started.success }
        : { _tag: "RetryStart" as const, submission: added.success };
    }
    if (added.failure.kind === "ambiguous") return { _tag: "Reconcile" as const };
    return yield* added.failure;
  }), dependencies);

  return firstAttempt.pipe(Effect.flatMap((attempt): Effect.Effect<CodexQueueDelivery, CodexAppServerError> => {
    if (attempt._tag === "Delivered") {
      return Effect.succeed({
        submission: attempt.submission,
        state: attempt.state,
        reconciled: false,
      });
    }
    if (attempt._tag === "RetryStart") {
      // The add receipt is durable and the queued submission id is stable, so
      // retrying start on a fresh connection cannot duplicate the message.
      // A second failure remains an accepted queue item; never escape to the
      // terminal fallback after wt knows Codex owns the payload.
      return Effect.result(withCodexAppServer(
        (client) => client.queueStart(args.threadId, attempt.submission.id),
        dependencies,
      )).pipe(Effect.map((retried) => ({
        submission: attempt.submission,
        state: Result.isSuccess(retried) ? retried.success : "queued-or-started" as const,
        reconciled: false,
      })));
    }
    // A transport failure after queue/add started writing is ambiguous. The
    // failed connection is released before this fresh connection asks the
    // server whether it owns the stable client message id. Never re-add it.
    return withCodexAppServer((client) => Effect.gen(function* () {
      const ownership = yield* reconcileSubmission(client, args.threadId, clientUserMessageId);
      const state = ownership.state === "started"
        ? "started" as const
        : yield* client.queueStart(args.threadId, ownership.submission.id);
      return { submission: ownership.submission, state, reconciled: true };
    }), dependencies);
  }));
}

export const __testing = { maskFrame, expectedAccept };
