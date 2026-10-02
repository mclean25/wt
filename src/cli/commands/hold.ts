import { Effect } from "effect";

import { agentIdentity } from "../../core/agent-identity.ts";
import {
  checkCommunicationHold,
  getCommunicationHold,
  releaseCommunicationHold,
  setCommunicationHold,
} from "../../core/communication-holds.ts";
import { hasHelpFlag } from "../args.ts";
import { red } from "../colors.ts";

const USAGE = `usage: wt hold set <resource> --scope <operations> --at <event-ISO> --until <ISO> [--owner <name>] <reason>
       wt hold release <resource> --at <event-ISO> [--owner <name>] <reason>
       wt hold check <id>
       wt hold status <resource>

Bounded resource coordination, never a work-status or merge gate.
Owner defaults to WT_AGENT; outside an agent, --owner is required.
--at is the ORIGINAL event time, not delivery time. Windows are at most one hour.
Set/release update local state without messaging any agent. Release when mutation ends.
Share an existing reference with wt agent send <target> --hold <id>.
Check/status return JSON: only active:true authorizes the stated resource hold.
Exit 0 means the read completed, not that the hold is active. Errors grant no hold.
Expired, released, superseded and unknown IDs cannot pause new work.`;

type HoldArgs =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "check"; value: string }
  | { kind: "status"; value: string }
  | { kind: "set" | "release"; resource: string; owner: string; eventAt: string; reason: string; scope: string; until: string };

export function parseHoldArgs(argv: string[], defaultOwner: string | null): HoldArgs {
  if (hasHelpFlag(argv)) return { kind: "help" };
  const [kind, resource, ...rest] = argv;
  if (kind === "check" || kind === "status") {
    if (!resource || rest.length) return { kind: "error", message: `wt hold ${kind} requires exactly one ${kind === "check" ? "ID" : "resource"}` };
    return { kind, value: resource };
  }
  if ((kind !== "set" && kind !== "release") || !resource || resource.startsWith("-")) {
    return { kind: "error", message: "expected wt hold set, release, check, or status" };
  }
  const flags = new Map<string, string>();
  const words: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === "--") { words.push(...rest.slice(i + 1)); break; }
    if (!arg.startsWith("-")) { words.push(arg); continue; }
    const allowed = kind === "set" ? ["--owner", "--at", "--until", "--scope"] : ["--owner", "--at"];
    if (!allowed.includes(arg)) return { kind: "error", message: `unknown flag: ${arg}` };
    if (flags.has(arg)) return { kind: "error", message: `duplicate flag: ${arg}` };
    const value = rest[++i];
    if (!value?.trim() || value.startsWith("--")) return { kind: "error", message: `${arg} requires a value` };
    flags.set(arg, value.trim());
  }
  const owner = flags.get("--owner") ?? defaultOwner;
  const eventAt = flags.get("--at");
  const scope = flags.get("--scope") ?? "";
  const until = flags.get("--until") ?? "";
  const reason = words.join(" ").trim();
  if (!owner || !eventAt || !reason || (kind === "set" && (!scope || !until))) {
    return { kind: "error", message: "owner, original --at and reason are required; set also requires --scope and --until" };
  }
  return { kind, resource, owner, eventAt, reason, scope, until };
}

export const run = Effect.fn("wt hold")(function* (argv: string[]) {
  const args = parseHoldArgs(argv, agentIdentity());
  if (args.kind === "help") { console.log(USAGE); return 0; }
  if (args.kind === "error") { console.error(red(args.message)); console.error(USAGE); return 2; }
  if (args.kind === "check" || args.kind === "status") {
    const result = yield* (args.kind === "check"
      ? checkCommunicationHold(args.value)
      : getCommunicationHold(args.value));
    console.log(JSON.stringify(result));
    return 0;
  }
  const input = { resource: args.resource, owner: args.owner, eventAt: args.eventAt, reason: args.reason };
  if (args.kind === "release") {
    yield* releaseCommunicationHold(input);
    console.log(JSON.stringify({ released: true, resource: args.resource, eventAt: args.eventAt }));
  } else {
    const hold = yield* setCommunicationHold({ ...input, scope: args.scope, until: args.until });
    console.log(JSON.stringify(hold));
  }
  return 0;
});
