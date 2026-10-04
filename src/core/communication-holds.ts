/** Host-local, bounded coordination notices. Reads and replays never extend a hold. */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Clock, Data, Effect, Schema } from "effect";

import { config } from "./config.ts";
import { causeMessage, operationErrors } from "./errors.ts";
import { withAsyncFileLock } from "./locks.ts";

const io = operationErrors("communication holds");
export const COMMUNICATION_HOLDS_PATH = join(dirname(config.paths.stateDb), "communication-holds.json");
export const MAX_COMMUNICATION_HOLD_MS = 60 * 60 * 1000;

const inputFields = {
  resource: Schema.String,
  scope: Schema.String,
  owner: Schema.String,
  eventAt: Schema.String,
  until: Schema.String,
  reason: Schema.String,
};
const releaseFields = {
  resource: Schema.String,
  owner: Schema.String,
  eventAt: Schema.String,
  reason: Schema.String,
};
const InputSchema = Schema.Struct(inputFields);
const HoldSchema = Schema.Struct({ id: Schema.String, ...inputFields });
const ReleaseSchema = Schema.Struct(releaseFields);
const EventSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("hold"), hold: HoldSchema }),
  Schema.Struct({ kind: Schema.Literal("release"), release: ReleaseSchema }),
]);
const StoreSchema = Schema.Struct({ version: Schema.Literal(1), events: Schema.Array(EventSchema) });
const decodeInput = Schema.decodeUnknownSync(InputSchema);
const decodeRelease = Schema.decodeUnknownSync(ReleaseSchema);
const decodeStore = Schema.decodeUnknownSync(StoreSchema);

export type SetCommunicationHoldInput = typeof InputSchema.Type;
export type CommunicationHold = typeof HoldSchema.Type;
export type ReleaseCommunicationHoldInput = typeof ReleaseSchema.Type;
export type CommunicationHoldCheck = {
  readonly active: boolean;
  readonly reason: string;
  readonly hold: CommunicationHold | null;
};
type HoldEvent = typeof EventSchema.Type;
type Store = Map<string, HoldEvent>;

export class CommunicationHoldError extends Data.TaggedError("CommunicationHoldError")<{
  readonly code: "invalid" | "stale" | "active" | "owner";
  readonly detail: string;
}> {
  override get message(): string { return `communication hold: ${this.detail}`; }
}

function invalid(detail: string): never {
  throw new CommunicationHoldError({ code: "invalid", detail });
}

function nonempty(value: string, name: string): void {
  if (!value.trim() || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    invalid(`${name} must be a nonempty, trimmed, single-line string`);
  }
}

/** Require an explicit timezone and preserve millisecond event ordering. */
function timestamp(value: string, name: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return invalid(`${name} must be an ISO timestamp with an explicit timezone`);
  const local = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  const localTime = Date.parse(local);
  const time = Date.parse(value);
  if (!Number.isFinite(localTime) || !Number.isFinite(time) || new Date(localTime).toISOString() !== local) {
    return invalid(`${name} must be a valid ISO timestamp`);
  }
  return new Date(time).toISOString();
}

function normalizeInput(input: SetCommunicationHoldInput): SetCommunicationHoldInput {
  const parsed = decodeInput(input, { onExcessProperty: "error" });
  for (const key of ["resource", "scope", "owner", "reason"] as const) nonempty(parsed[key], key);
  const eventAt = timestamp(parsed.eventAt, "eventAt");
  const until = timestamp(parsed.until, "until");
  const duration = Date.parse(until) - Date.parse(eventAt);
  if (duration <= 0 || duration > MAX_COMMUNICATION_HOLD_MS) {
    invalid("until must be after eventAt and no more than one hour later");
  }
  return { ...parsed, eventAt, until };
}

function normalizeRelease(input: ReleaseCommunicationHoldInput): ReleaseCommunicationHoldInput {
  const parsed = decodeRelease(input, { onExcessProperty: "error" });
  for (const key of ["resource", "owner", "reason"] as const) nonempty(parsed[key], key);
  return { ...parsed, eventAt: timestamp(parsed.eventAt, "eventAt") };
}

function holdId(input: SetCommunicationHoldInput): string {
  return createHash("sha256").update(JSON.stringify([input.resource, input.owner, input.eventAt])).digest("hex");
}

function eventRecord(event: HoldEvent): CommunicationHold | ReleaseCommunicationHoldInput {
  return event.kind === "hold" ? event.hold : event.release;
}

function sameHold(a: CommunicationHold, b: CommunicationHold): boolean {
  return a.id === b.id && a.resource === b.resource && a.scope === b.scope && a.owner === b.owner &&
    a.eventAt === b.eventAt && a.until === b.until && a.reason === b.reason;
}

function parseStore(text: string): Store {
  const parsed = decodeStore(JSON.parse(text), { onExcessProperty: "error" });
  const store: Store = new Map();
  for (const event of parsed.events) {
    const record = eventRecord(event);
    if (store.has(record.resource)) invalid(`duplicate resource in storage: ${record.resource}`);
    if (event.kind === "hold") {
      const { id, ...input } = event.hold;
      const normalized = normalizeInput(input);
      if (!sameHold(event.hold, { id: holdId(normalized), ...normalized }) || !/^[a-f0-9]{64}$/.test(id)) {
        invalid(`invalid stored hold for ${record.resource}`);
      }
    } else if (normalizeRelease(event.release).eventAt !== event.release.eventAt) {
      invalid(`noncanonical release timestamp for ${record.resource}`);
    }
    store.set(record.resource, event);
  }
  return store;
}

const readStore = Effect.fnUntraced(function* (path: string) {
  const text = yield* io.sync(`read communication holds at ${path}`, () => {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  });
  return text === null ? new Map<string, HoldEvent>() : yield* io.sync(`parse communication holds at ${path}`, () => parseStore(text));
});

const writeStore = Effect.fnUntraced(function* (path: string, store: Store) {
  yield* io.sync(`write communication holds at ${path}`, () => {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ version: 1, events: [...store.values()] }, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  });
});

const validate = Effect.fnUntraced(function* <A>(evaluate: () => A) {
  return yield* Effect.try({
    try: evaluate,
    catch: (error) => error instanceof CommunicationHoldError ? error : new CommunicationHoldError({ code: "invalid", detail: causeMessage(error) }),
  });
});

function activeHold(hold: CommunicationHold, now: number): boolean {
  return Date.parse(hold.eventAt) <= now && now < Date.parse(hold.until);
}

/** Exact replay returns the original hold; a new event cannot renew an active one. */
export const setCommunicationHold = Effect.fn("setCommunicationHold")(function* (
  input: SetCommunicationHoldInput,
  path: string = COMMUNICATION_HOLDS_PATH,
) {
  const normalized = yield* validate(() => normalizeInput(input));
  const hold: CommunicationHold = { id: holdId(normalized), ...normalized };
  return yield* withAsyncFileLock(basename(path), Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const store = yield* readStore(path);
    const previous = store.get(hold.resource);
    if (Date.parse(hold.eventAt) > now) {
      return yield* new CommunicationHoldError({ code: "invalid", detail: "eventAt cannot be in the future" });
    }
    if (previous?.kind === "hold" && sameHold(previous.hold, hold)) return previous.hold;
    if (previous && Date.parse(hold.eventAt) <= Date.parse(eventRecord(previous).eventAt)) {
      return yield* new CommunicationHoldError({ code: "stale", detail: `eventAt must be newer than the latest event for ${hold.resource}` });
    }
    if (previous?.kind === "hold" && activeHold(previous.hold, now)) {
      return yield* new CommunicationHoldError({ code: "active", detail: `${hold.resource} is already held by ${previous.hold.owner} until ${previous.hold.until}` });
    }
    store.set(hold.resource, { kind: "hold", hold });
    yield* writeStore(path, store);
    return hold;
  }), { directory: dirname(path) });
});

/** Releases are durable ordering watermarks, including when no hold arrived yet. */
export const releaseCommunicationHold = Effect.fn("releaseCommunicationHold")(function* (
  input: ReleaseCommunicationHoldInput,
  path: string = COMMUNICATION_HOLDS_PATH,
) {
  const release = yield* validate(() => normalizeRelease(input));
  yield* withAsyncFileLock(basename(path), Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const store = yield* readStore(path);
    const previous = store.get(release.resource);
    const eventTime = Date.parse(release.eventAt);
    if (eventTime > now) {
      return yield* new CommunicationHoldError({ code: "invalid", detail: "eventAt cannot be in the future" });
    }
    if (previous && eventTime < Date.parse(eventRecord(previous).eventAt)) {
      return yield* new CommunicationHoldError({ code: "stale", detail: `release is older than the latest event for ${release.resource}` });
    }
    if (previous?.kind === "release" && release.eventAt === previous.release.eventAt) return;
    if (previous?.kind === "hold" && activeHold(previous.hold, now) && release.owner !== previous.hold.owner) {
      return yield* new CommunicationHoldError({ code: "owner", detail: `${release.resource} is held by ${previous.hold.owner}, not ${release.owner}` });
    }
    store.set(release.resource, { kind: "release", release });
    yield* writeStore(path, store);
  }), { directory: dirname(path) });
});

function checkEvent(event: HoldEvent | undefined, now: number): CommunicationHoldCheck {
  if (!event) return { active: false, reason: "hold is unknown or superseded", hold: null };
  if (event.kind === "release") return { active: false, reason: `released at ${event.release.eventAt}: ${event.release.reason}`, hold: null };
  const { hold } = event;
  const active = activeHold(hold, now);
  return { active, reason: active ? hold.reason : `hold is inactive; deadline ${hold.until}`, hold };
}

/** Read-only: acknowledgments and reference checks cannot write or extend state. */
export const checkCommunicationHold = Effect.fn("checkCommunicationHold")(function* (
  id: string,
  path: string = COMMUNICATION_HOLDS_PATH,
) {
  yield* validate(() => { if (!/^[a-f0-9]{64}$/.test(id)) invalid("id must be a SHA-256 hold identifier"); });
  const store = yield* readStore(path);
  const now = yield* Clock.currentTimeMillis;
  return checkEvent([...store.values()].find((event) => event.kind === "hold" && event.hold.id === id), now);
});

export const getCommunicationHold = Effect.fn("getCommunicationHold")(function* (
  resource: string,
  path: string = COMMUNICATION_HOLDS_PATH,
) {
  yield* validate(() => nonempty(resource, "resource"));
  const store = yield* readStore(path);
  const now = yield* Clock.currentTimeMillis;
  return checkEvent(store.get(resource), now);
});
