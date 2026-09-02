/**
 * A minimal WebSocket + JSC-inspector client speaking over a unix
 * socket, ported from unseamless-coop's `scripts/fleet/_inject`.
 *
 * Claude Code is a bun-compiled binary, so launching it with
 * `BUN_INSPECT=ws+unix://<path>` exposes bun's JSC/WebKit inspector on
 * that path. The inspector protocol rides a websocket, so a handshake
 * plus masked text frames is the entire client. Pulling in a WS library
 * for this would be more code, not less: the framing below is ~60 lines
 * and has no failure mode a dependency would remove.
 *
 * Only three inspector methods are used: `Runtime.enable`,
 * `Runtime.evaluate` (to reach `process.stdin`'s listener) and
 * `Runtime.callFunctionOn` (to run the page routine bound to the Ink
 * App instance).
 *
 * EVERY WAIT HERE IS BOUNDED, and that is load-bearing rather than
 * defensive: this client sits on the delivery path of every message in
 * the fleet, and its whole contract with `transport.ts` is that failure
 * is survivable — a hang is the one outcome the caller can't fall back
 * from.
 */
import { createHash, randomBytes } from "node:crypto";

/** Anything the inspector can hand back for a `Runtime.*` result. */
type InspectorResult = {
  result?: { objectId?: string; value?: unknown };
  internalProperties?: { name: string; value?: { objectId?: string } }[];
  /** Present when the evaluated function threw inside the target. */
  exceptionDetails?: { text?: string; exception?: { description?: string } };
};

export type InspectorClient = {
  call(method: string, params?: Record<string, unknown>): Promise<InspectorResult>;
  close(): void;
};

/** Handshake budget. A peer that accepts but never upgrades is a hang. */
const UPGRADE_TIMEOUT_MS = 3_000;
/**
 * Ceiling on buffered inbound bytes. Inspector replies here are tiny
 * (a JSON string of a few hundred bytes); anything approaching this is
 * a peer that isn't the inspector, or one that has gone wrong, and the
 * right move is to fail the connection rather than grow forever.
 */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/** RFC 6455's fixed handshake GUID. */
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function expectedAccept(key: string): string {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/**
 * Frame `text` as a masked client->server frame of `opcode`. The mask is
 * random per frame per RFC 6455, though nothing here depends on it: the
 * rule exists to defeat cache-poisoning of transparent HTTP proxies, and
 * there is no proxy on a unix socket.
 */
function maskFrame(text: string, opcode = 0x1): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i += 1) masked[i] = payload[i]! ^ mask[i & 3]!;
  return Buffer.concat([header, mask, masked]);
}

/** Exported for unit tests — the length-boundary branches above are the point. */
export const __testing = { maskFrame, expectedAccept };

/**
 * Connect to a bun inspector listening on `socketPath`.
 *
 * Rejects when nothing is accepting on the path — which is the
 * "stale socket" case worth distinguishing from a missing file: the
 * live process holds a now-unlinked socket inode and only IT can rebind
 * the path, so the caller's advice is "restart that session", not
 * "retry shortly". Also rejects, rather than hanging, when the peer
 * accepts the connection but never completes the upgrade.
 */
export async function connectInspector(socketPath: string, signal?: AbortSignal): Promise<InspectorClient> {
  let buf = Buffer.alloc(0);
  let upgraded = false;
  let nextId = 1;
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;
  const waiters = new Map<
    number,
    { resolve(value: InspectorResult): void; reject(err: Error): void }
  >();

  type Sock = { write(data: Uint8Array): number; end(): void };
  let socket: Sock | null = null;
  /** Held from `open` so a failed upgrade can still be torn down. */
  let rawSocket: Sock | null = null;
  let dead: Error | null = null;
  /**
   * Bytes handed to `write` that the kernel would not take yet.
   *
   * `Socket.write` is NOT all-or-nothing: it returns how much it
   * actually wrote and the remainder is the caller's problem. Measured
   * on a unix socket with a peer busy in JS, a 4500-byte buffer goes
   * whole, 5000 writes 2692, and anything larger returns 0 — so
   * ignoring the return value truncated every frame past ~4.5KB
   * mid-payload. The inspector then sat waiting for the rest of a
   * message that never came, the reply never arrived, and the send
   * surfaced as "did not acknowledge the submit": a size-only failure
   * with no bad content anywhere near it.
   */
  let pending: Buffer | null = null;

  const key = randomBytes(16).toString("base64");

  /**
   * Fail every in-flight call. Without this a clean remote close (a
   * session exiting mid-send) leaves callers pending until their own
   * outer deadline, and the waiter entries leak.
   */
  function failAll(err: Error): void {
    dead = err;
    for (const waiter of waiters.values()) waiter.reject(err);
    waiters.clear();
  }

  /**
   * Write `data`, keeping whatever the socket refused for the next
   * `drain`.
   *
   * Queuing is strictly FIFO and a new frame NEVER jumps an unwritten
   * tail: a frame written into the middle of another one's payload
   * corrupts the stream for every message after it, which is a far
   * worse failure than the truncation this fixes.
   */
  function sendRaw(data: Buffer): void {
    const s = socket ?? rawSocket;
    if (!s) throw new Error("inspector socket is not open");
    if (pending) {
      pending = Buffer.concat([pending, data]);
      flushPending();
      return;
    }
    const wrote = s.write(data);
    if (wrote < data.length) pending = data.subarray(Math.max(0, wrote));
  }

  /** Resume a partial write. Called on `drain` and after queuing. */
  function flushPending(): void {
    const s = socket ?? rawSocket;
    if (!pending || !s) return;
    const wrote = s.write(pending);
    pending = wrote >= pending.length ? null : pending.subarray(Math.max(0, wrote));
  }

  function* frames(): Generator<string> {
    while (buf.length >= 2) {
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (buf.length < offset + len) return;
      const payload = buf.subarray(offset, offset + len);
      buf = buf.subarray(offset + len);
      if (opcode === 0x8) {
        // Close: answer it so the peer can tear down cleanly, then fail
        // anything still waiting rather than leaving it to time out.
        try {
          sendRaw(maskFrame("", 0x8));
        } catch {
          // The peer is already gone; nothing to acknowledge.
        }
        failAll(new Error("inspector closed the connection"));
        return;
      }
      // RFC 6455 §5.5.2: a Ping must be answered with a Pong carrying
      // the same payload. bun's inspector does not appear to ping, but
      // the frame is already parsed, so answering costs one line.
      if (opcode === 0x9) {
        try {
          sendRaw(maskFrame(payload.toString("utf8"), 0xa));
        } catch {
          // Best effort; a failed pong is not worth failing the call.
        }
        continue;
      }
      if (opcode === 0xa) continue; // pong
      fragments.push(Buffer.from(payload));
      fragmentBytes += payload.length;
      if (fragmentBytes > MAX_BUFFER_BYTES) {
        failAll(new Error("inspector message exceeded the reassembly cap"));
        return;
      }
      if (fin) {
        const message = Buffer.concat(fragments).toString("utf8");
        fragments = [];
        fragmentBytes = 0;
        yield message;
      }
    }
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (err) {
        // Tear the connection down explicitly: on a failed upgrade
        // `socket` was never assigned, so without `rawSocket` there
        // would be no handle to close and a live connection would be
        // abandoned to the GC.
        try {
          rawSocket?.end();
        } catch {
          // Already gone.
        }
        reject(err);
      } else {
        resolve();
      }
    };
    const onAbort = () => finish(new Error("inspector connection interrupted"));
    const timer = setTimeout(
      () => finish(new Error("inspector did not complete the websocket upgrade")),
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
        open(s) {
          rawSocket = s;
          // Abort/timeout can win before Bun reports the opened socket.
          // In that race finish() had no handle to close, so the late
          // connection must be rejected here before any upgrade bytes leave.
          if (settled) {
            s.end();
            return;
          }
          sendRaw(
            Buffer.from(
              "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
            ),
          );
        },
        drain() {
          flushPending();
        },
        data(s, d) {
          if (!upgraded) {
            // Accumulate: a 101 response split across two reads is
            // ordinary, and scanning only the current chunk for the
            // header terminator would miss it and hang forever.
            buf = Buffer.concat([buf, Buffer.from(d)]);
            if (buf.length > MAX_BUFFER_BYTES) {
              finish(new Error("inspector handshake response was implausibly large"));
              return;
            }
            const str = buf.toString("latin1");
            const end = str.indexOf("\r\n\r\n");
            if (end === -1) return;
            const head = str.slice(0, end);
            if (!head.startsWith("HTTP/1.1 101")) {
              finish(new Error(`inspector refused the websocket upgrade: ${head.split("\r\n")[0]}`));
              return;
            }
            // Validate the accept header. Without it, ANY process
            // willing to answer 101 on that path is trusted as the
            // inspector — and this connection hands it our fiber-walk
            // routine to run.
            const accept = /^sec-websocket-accept:\s*(\S+)/im.exec(head)?.[1];
            if (accept !== expectedAccept(key)) {
              finish(new Error("inspector handshake failed Sec-WebSocket-Accept validation"));
              return;
            }
            upgraded = true;
            buf = buf.subarray(Buffer.byteLength(str.slice(0, end + 4), "latin1"));
            socket = s;
            finish();
            return;
          }
          buf = Buffer.concat([buf, Buffer.from(d)]);
          if (buf.length > MAX_BUFFER_BYTES) {
            failAll(new Error("inspector response exceeded the buffer cap"));
            return;
          }
          for (const text of frames()) {
            let message: { id?: number; error?: unknown; result?: InspectorResult };
            try {
              message = JSON.parse(text);
            } catch {
              continue;
            }
            if (typeof message.id !== "number") continue;
            const waiter = waiters.get(message.id);
            if (!waiter) continue;
            waiters.delete(message.id);
            if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
            else waiter.resolve((message.result ?? {}) as InspectorResult);
          }
        },
        error(_s, err) {
          const wrapped = new Error(`inspector socket: ${err?.message ?? String(err)}`);
          // Before the upgrade this rejects the handshake; after it, the
          // handshake promise is settled and `finish` is inert, so the
          // error has to reach the in-flight calls instead.
          finish(wrapped);
          failAll(wrapped);
        },
        close() {
          finish(new Error("inspector socket closed during the handshake"));
          failAll(new Error("inspector socket closed"));
        },
      },
    }).catch((err) => finish(err instanceof Error ? err : new Error(String(err))));
  });

  return {
    call(method, params) {
      if (dead) return Promise.reject(dead);
      const id = nextId++;
      return new Promise<InspectorResult>((resolve, reject) => {
        waiters.set(id, { resolve, reject });
        try {
          sendRaw(maskFrame(JSON.stringify({ id, method, params: params ?? {} })));
        } catch (err) {
          waiters.delete(id);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    },
    close() {
      try {
        socket?.end();
      } catch {
        // already gone; nothing to release
      }
      // A caller closing mid-flight is still a caller owed an answer.
      failAll(new Error("inspector connection closed by wt"));
    },
  };
}

/**
 * Resolve a remote object id for the Ink `App` instance.
 *
 * Ink wires its input reader as a BOUND METHOD of the root App, so the
 * app instance is reachable as the bound-this of process.stdin's first
 * 'readable' listener. That indirection is the anchor — it survives
 * minification, where a name would not. This is Claude/Ink-specific
 * knowledge sitting in an otherwise generic client; if this file grows,
 * it is the piece to move out to `transport.ts`.
 */
export async function appInstanceObjectId(client: InspectorClient): Promise<string> {
  const listener = await client.call("Runtime.evaluate", {
    expression: 'process.stdin.listeners("readable")[0]',
    objectGroup: "wt-inject",
  });
  const objectId = listener.result?.objectId;
  if (!objectId) {
    throw new Error("no stdin 'readable' listener (target not an interactive TUI?)");
  }
  const props = await client.call("Runtime.getProperties", {
    objectId,
    ownProperties: true,
  });
  const boundThis = (props.internalProperties ?? []).find((p) => /bound.?this/i.test(p.name));
  const appId = boundThis?.value?.objectId;
  if (!appId) throw new Error("stdin listener is not a bound method (Ink wiring changed)");
  return appId;
}

/**
 * The target-side exception from a `Runtime.*` result, if it threw.
 *
 * Without this a throw inside the evaluated routine surfaces as an
 * empty `result.value`, which `JSON.parse` then reports as "Unexpected
 * end of JSON input" — a message that both hides the real cause and
 * fails the caller's failure-classification match, so a moved anchor
 * would be misreported as a generic failure exactly when the diagnosis
 * matters most.
 */
export function inspectorException(res: InspectorResult): string | null {
  const details = res.exceptionDetails;
  if (!details) return null;
  return details.exception?.description ?? details.text ?? "target threw during evaluation";
}
