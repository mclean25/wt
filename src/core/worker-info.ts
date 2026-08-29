import type { RemoteConfig } from "./config.ts";
import { run } from "./proc.ts";
import { remoteWtCommand } from "./remote-protocol.ts";
import { wtVersion } from "./update.ts";

/** Incompatible controller/worker wire changes increment this value. */
export const WORKER_PROTOCOL_VERSION = 2;

export type WorkerInfo = {
  role: "controller" | "worker";
  protocol: number;
  build: string;
};

export function currentWorkerInfo(role: WorkerInfo["role"]): WorkerInfo {
  return { role, protocol: WORKER_PROTOCOL_VERSION, build: wtVersion() };
}

export function parseWorkerInfo(raw: string): WorkerInfo {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new Error("remote worker handshake did not return JSON — run sync-wt");
  }
  if (!value || typeof value !== "object") {
    throw new Error("remote worker handshake returned an invalid payload");
  }
  const info = value as Partial<WorkerInfo>;
  if (info.role !== "controller" && info.role !== "worker") {
    throw new Error("remote worker handshake did not report a valid role");
  }
  if (typeof info.protocol !== "number" || !Number.isInteger(info.protocol)) {
    throw new Error("remote worker handshake did not report a protocol version");
  }
  if (typeof info.build !== "string" || info.build.trim() === "") {
    throw new Error("remote worker handshake did not report a build");
  }
  return { role: info.role, protocol: info.protocol, build: info.build };
}

const successful = new Map<string, WorkerInfo>();
const inFlight = new Map<string, Promise<WorkerInfo>>();

/** Handshake once per endpoint/process; only successful answers are cached. */
export async function fetchRemoteWorkerInfo(
  remote: RemoteConfig,
  signal?: AbortSignal,
): Promise<WorkerInfo> {
  const key = `${remote.host}\0${remote.wtPath}`;
  const cached = successful.get(key);
  if (cached) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = (async () => {
    const result = await run(
      [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        remote.host,
        remoteWtCommand(remote, ["_hello"]),
      ],
      { cwd: process.cwd(), timeoutMs: 15_000, signal },
    );
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `SSH exited ${result.exitCode}`;
      throw new Error(`remote worker handshake failed: ${detail}`);
    }
    const info = parseWorkerInfo(result.stdout);
    if (info.role !== "worker") {
      throw new Error(
        `remote ${remote.label} is configured as ${info.role}; set [instance] role = "worker" there`,
      );
    }
    if (info.protocol !== WORKER_PROTOCOL_VERSION) {
      throw new Error(
        `remote ${remote.label} uses protocol ${info.protocol}; this controller requires ${WORKER_PROTOCOL_VERSION} — run sync-wt`,
      );
    }
    successful.set(key, info);
    return info;
  })();
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    inFlight.delete(key);
  }
}
