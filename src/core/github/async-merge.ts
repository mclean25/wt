import { Effect } from "effect";

import { config } from "../config.ts";
import { run, type RunResult } from "../proc.ts";
import { GH_TIMEOUT_MS, ghFailureMessage } from "./gh-cli.ts";

export type AsyncMergeResult =
  | { ok: true }
  | { ok: false; error: string; definitive?: true; retryable?: false };

type Executor = (argv: string[]) => Effect.Effect<RunResult>;
const execute = Effect.fnUntraced(function* (argv: string[]) {
  return yield* run(argv, { cwd: config.paths.mainClone, timeoutMs: GH_TIMEOUT_MS }).pipe(
    Effect.catch((error) => Effect.succeed({ stdout: "", stderr: error.message, exitCode: -1 })),
  );
});

type Response = { code: number; status: string; details: Record<string, unknown> };
function response(result: RunResult): Response | null {
  // --include preserves the HTTP code even when gh exits nonzero (409).
  const match = /^HTTP\/[\d.]+\s+(\d+)[^\r\n]*\r?\n[\s\S]*?\r?\n\r?\n([\s\S]*)$/.exec(result.stdout);
  if (!match) return null;
  try {
    const body: unknown = JSON.parse(match[2]!);
    if (!body || typeof body !== "object" || !("status" in body) || !("details" in body)) return null;
    if (typeof body.status !== "string" || !body.details || typeof body.details !== "object") return null;
    const details = body.details as Record<string, unknown>;
    if (typeof details.message !== "string" || !details.message) return null;
    return { code: Number(match[1]), status: body.status, details };
  } catch { return null; }
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
}

function terminal(value: Response): AsyncMergeResult | null {
  if (value.status === "failed") return { ok: false, error: String(value.details.message), definitive: true };
  if (value.status === "enqueued") return { ok: true };
  if (value.status === "merged" && typeof value.details.sha === "string" && value.details.sha.length > 0) return { ok: true };
  return null;
}

/** Submit exactly once; only a terminal queue result is success, never HTTP 202. */
export const enqueueAsyncMerge = Effect.fn("enqueueAsyncMerge")(function* (
  repoSlug: string,
  prNumber: number,
  headRefOid: string,
  executor: Executor = execute,
): Effect.fn.Return<AsyncMergeResult> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repoSlug) || !Number.isSafeInteger(prNumber) || prNumber < 1 || !headRefOid) {
    return { ok: false, error: "async merge requires a repository, PR number, and expected head SHA" };
  }
  const endpoint = `repos/${repoSlug}/pulls/${prNumber}/merge-async`;
  const headers = ["-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2026-03-10"];
  let uuid: string | undefined;
  const uncertain = (reason: string): AsyncMergeResult => ({
    ok: false,
    retryable: false,
    error: `${reason}. Async merge outcome unconfirmed; do not resubmit. ${uuid
      ? `Request ${uuid}; inspect with: gh api ${endpoint}/${uuid}`
      : `Inspect PR #${prNumber} on ${repoSlug} before retrying (no request UUID received)`}`,
  });
  const submitted = yield* executor([
    "gh", "api", "--include", "--method", "PUT", endpoint, ...headers,
    "-f", `sha=${headRefOid}`, "-f", "merge_action=merge_queue", "-F", "bypass_rules=false",
  ]);
  const accepted = response(submitted);
  if (accepted && validUuid(accepted.details.uuid)) uuid = accepted.details.uuid;
  if (submitted.timedOut || !accepted) return uncertain(ghFailureMessage(submitted));
  if (accepted.code === 400 && accepted.status === "failed") return terminal(accepted)!;
  if (submitted.exitCode === 0 && accepted.code === 200 && accepted.status !== "failed") {
    const done = terminal(accepted);
    if (done) return done;
  }
  const matches = (value: Response) => value.status === "pending" && validUuid(value.details.uuid)
    && value.details.uuid === uuid && value.details.expected_head_sha === headRefOid
    && value.details.merge_action === "merge_queue"
    && ["default", "merge", "squash", "rebase"].includes(String(value.details.merge_method))
    && (value.details.bypass_rules === undefined || value.details.bypass_rules === false);
  if (!((accepted.code === 202 && submitted.exitCode === 0) || accepted.code === 409) || !matches(accepted)) {
    return uncertain(`GitHub returned incompatible async merge response: ${accepted.details.message}`);
  }
  const poll = Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(1_000);
      const result = yield* executor(["gh", "api", "--include", "--method", "GET", `${endpoint}/${uuid}`, ...headers]);
      const value = response(result);
      if (result.timedOut || result.exitCode !== 0 || !value || value.code !== 200) {
        return uncertain(`Cannot read async merge result: ${ghFailureMessage(result)}`);
      }
      const done = terminal(value);
      if (done) return done;
      if (!matches(value)) return uncertain("GitHub returned malformed or incompatible async merge result");
    }
  });
  return yield* poll.pipe(Effect.timeoutOrElse({
    duration: 60_000,
    orElse: () => Effect.succeed(uncertain("Async merge is still pending after 60 seconds")),
  }));
});
