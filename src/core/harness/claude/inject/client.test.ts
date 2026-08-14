/**
 * The hand-rolled WebSocket layer, tested against a real unix socket.
 *
 * This is bespoke protocol code on the delivery path of every message
 * in the fleet, and its failure mode is the one the transport can't
 * absorb: a hang. So the cases here are the boundaries (payload length
 * encodings), the splits (a handshake or a frame arriving across two
 * reads), and the ways a peer can go wrong (never upgrading, lying
 * about the handshake, closing mid-call).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { connectInspector, __testing } from "./client.ts";

const { maskFrame, expectedAccept } = __testing;

const dirs: string[] = [];
const servers: { stop(closeActiveConnections?: boolean): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function socketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "wt-inspector-test-"));
  dirs.push(dir);
  return join(dir, "inspect.sock");
}

/** Unmask one complete client->server text frame; null if incomplete. */
function readClientFrame(buf: Buffer): { text: string; rest: Buffer } | null {
  if (buf.length < 2) return null;
  let len = buf[1]! & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    offset = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    offset = 10;
  }
  const masked = (buf[1]! & 0x80) !== 0;
  const maskLen = masked ? 4 : 0;
  if (buf.length < offset + maskLen + len) return null;
  const mask = buf.subarray(offset, offset + maskLen);
  const payload = Buffer.from(buf.subarray(offset + maskLen, offset + maskLen + len));
  if (masked) for (let i = 0; i < payload.length; i += 1) payload[i]! ^= mask[i & 3]!;
  return { text: payload.toString("utf8"), rest: buf.subarray(offset + maskLen + len) };
}

/** Server->client text frame (unmasked, as the server side must be). */
function serverFrame(text: string, opcode = 0x1, fin = true): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([(fin ? 0x80 : 0x00) | opcode, len]);
  else {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}

type StubOpts = {
  /** Skip the 101 entirely — the "accepts but never upgrades" hang. */
  neverUpgrade?: boolean;
  /** Answer with a wrong Sec-WebSocket-Accept. */
  badAccept?: boolean;
  /** Split the handshake response across two writes. */
  splitHandshake?: boolean;
  /** Reply to a call in two continuation frames instead of one. */
  fragmentReplies?: boolean;
  /** Send a ping before replying. */
  pingFirst?: boolean;
  /** Close the connection instead of replying. */
  closeOnCall?: boolean;
  /** Reply body for `Runtime.*`, by method. */
  reply?(method: string): unknown;
};

function stubInspector(path: string, opts: StubOpts = {}) {
  const pongs: string[] = [];
  const received: string[] = [];
  const server = Bun.listen<{ buf: Buffer; up: boolean }>({
    unix: path,
    socket: {
      open(s) {
        s.data = { buf: Buffer.alloc(0), up: false };
      },
      data(s, chunk) {
        s.data.buf = Buffer.concat([s.data.buf, Buffer.from(chunk)]);
        if (!s.data.up) {
          const text = s.data.buf.toString("latin1");
          const end = text.indexOf("\r\n\r\n");
          if (end === -1) return;
          if (opts.neverUpgrade) return;
          const key = /sec-websocket-key:\s*(\S+)/i.exec(text)?.[1] ?? "";
          const accept = opts.badAccept
            ? createHash("sha1").update("wrong").digest("base64")
            : expectedAccept(key);
          const head =
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`;
          if (opts.splitHandshake) {
            const cut = Math.floor(head.length / 2);
            s.write(Buffer.from(head.slice(0, cut), "latin1"));
            s.write(Buffer.from(head.slice(cut), "latin1"));
          } else {
            s.write(Buffer.from(head, "latin1"));
          }
          s.data.up = true;
          s.data.buf = s.data.buf.subarray(end + 4);
        }
        for (;;) {
          const frame = readClientFrame(s.data.buf);
          if (!frame) return;
          s.data.buf = frame.rest;
          let msg: { id?: number; method?: string };
          try {
            msg = JSON.parse(frame.text);
            received.push(frame.text);
          } catch {
            // A pong (or a close) carries no JSON — record and move on.
            pongs.push(frame.text);
            continue;
          }
          if (opts.closeOnCall) {
            s.end();
            return;
          }
          if (opts.pingFirst) s.write(serverFrame("ping-payload", 0x9));
          const body = JSON.stringify({
            id: msg.id,
            result: opts.reply?.(msg.method ?? "") ?? {},
          });
          if (opts.fragmentReplies) {
            const cut = Math.floor(body.length / 2);
            s.write(serverFrame(body.slice(0, cut), 0x1, false));
            s.write(serverFrame(body.slice(cut), 0x0, true));
          } else {
            s.write(serverFrame(body));
          }
        }
      },
    },
  });
  servers.push(server);
  return { pongs, received };
}

describe("websocket framing", () => {
  test("payload length uses the right encoding at each boundary", () => {
    // 125/126 and 65535/65536 are where the header grows. An off-by-one
    // here corrupts only large messages, which is exactly the kind of
    // bug that survives every manual smoke test.
    expect(maskFrame("x".repeat(125))[1]! & 0x7f).toBe(125);
    expect(maskFrame("x".repeat(126))[1]! & 0x7f).toBe(126);
    expect(maskFrame("x".repeat(126)).length).toBe(4 + 4 + 126);
    expect(maskFrame("x".repeat(65535))[1]! & 0x7f).toBe(126);
    expect(maskFrame("x".repeat(65536))[1]! & 0x7f).toBe(127);
    expect(maskFrame("x".repeat(65536)).length).toBe(10 + 4 + 65536);
  });

  test("every client frame is masked, as the spec requires of clients", () => {
    expect(maskFrame("hi")[1]! & 0x80).toBe(0x80);
  });

  test("a masked frame round-trips back to its payload", () => {
    const body = "a".repeat(70_000); // exercises the 8-byte length path
    const decoded = readClientFrame(maskFrame(body));
    expect(decoded?.text).toBe(body);
  });
});

describe("the inspector client", () => {
  // The regression this pins: `Socket.write` short-writes past roughly
  // 4.5KB on a unix socket, and the old code ignored its return value,
  // so the tail of every larger frame was dropped on the floor. The
  // peer then waited forever for the rest of a message that never came
  // and the send failed as "did not acknowledge the submit" — purely as
  // a function of SIZE, which is why it read like an escaping bug and
  // sent everyone hunting through the payload for bad characters.
  //
  // The size here is deliberately far above the ~5KB seen in the field.
  // How much `write` accepts depends on how promptly the PEER reads,
  // and this stub reads eagerly, so 5000 bytes still goes through whole
  // against it — a 5000-byte case would pass with the bug reintroduced
  // and guard nothing. 200_000 is past the point where `write` accepts
  // anything at all, so it fails deterministically without the fix.
  test("delivers a payload larger than the socket's write buffer, whole", async () => {
    const path = socketPath();
    const stub = stubInspector(path, { reply: () => ({ result: { value: "ok" } }) });
    const client = await connectInspector(path);
    const body = "x".repeat(200_000);
    expect(await client.call("Runtime.callFunctionOn", { body })).toEqual({
      result: { value: "ok" },
    });
    // Not just "a reply arrived": the point is that every byte did.
    const sent = JSON.parse(stub.received[0]!) as { params: { body: string } };
    expect(sent.params.body).toBe(body);
    client.close();
  });

  test("completes a call over a real socket", async () => {
    const path = socketPath();
    stubInspector(path, { reply: () => ({ result: { value: "pong" } }) });
    const client = await connectInspector(path);
    expect(await client.call("Runtime.evaluate")).toEqual({ result: { value: "pong" } });
    client.close();
  });

  test("a handshake split across two writes still upgrades", async () => {
    // The original bug: the pre-upgrade branch scanned only the current
    // chunk for the header terminator, so a split response hung forever.
    const path = socketPath();
    stubInspector(path, { splitHandshake: true, reply: () => ({ result: { value: 1 } }) });
    const client = await connectInspector(path);
    expect(await client.call("Runtime.enable")).toEqual({ result: { value: 1 } });
    client.close();
  });

  test("a reply split across continuation frames is reassembled", async () => {
    const path = socketPath();
    stubInspector(path, { fragmentReplies: true, reply: () => ({ result: { value: "whole" } }) });
    const client = await connectInspector(path);
    expect(await client.call("Runtime.evaluate")).toEqual({ result: { value: "whole" } });
    client.close();
  });

  test("a peer that accepts but never upgrades fails instead of hanging", async () => {
    // The one outcome the transport can't fall back from.
    const path = socketPath();
    stubInspector(path, { neverUpgrade: true });
    expect(connectInspector(path)).rejects.toThrow(/upgrade/i);
  });

  test("a wrong Sec-WebSocket-Accept is refused", async () => {
    // Without this check, anything willing to answer 101 on that path is
    // handed our fiber-walk routine to run.
    const path = socketPath();
    stubInspector(path, { badAccept: true });
    expect(connectInspector(path)).rejects.toThrow(/Sec-WebSocket-Accept/);
  });

  test("nothing listening is a connect failure, not a hang", async () => {
    expect(connectInspector(socketPath())).rejects.toThrow();
  });

  test("a close mid-call rejects the caller rather than leaving it pending", async () => {
    // A session exiting mid-send used to leave the promise unsettled
    // until the caller's own 12s deadline.
    const path = socketPath();
    stubInspector(path, { closeOnCall: true });
    const client = await connectInspector(path);
    expect(client.call("Runtime.evaluate")).rejects.toThrow(/clos/i);
  });

  test("a server ping is answered with a pong", async () => {
    const path = socketPath();
    const stub = stubInspector(path, { pingFirst: true, reply: () => ({ result: { value: 1 } }) });
    const client = await connectInspector(path);
    await client.call("Runtime.evaluate");
    await Bun.sleep(50);
    client.close();
    expect(stub.pongs).toContain("ping-payload");
  });

  test("closing the client fails anything still in flight", async () => {
    const path = socketPath();
    stubInspector(path, { neverUpgrade: false, reply: () => ({}) });
    const client = await connectInspector(path);
    client.close();
    expect(client.call("Runtime.evaluate")).rejects.toThrow();
  });
});
