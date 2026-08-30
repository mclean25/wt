/**
 * One-shot, read-only completion through an installed coding-agent harness.
 *
 * This is deliberately separate from interactive session spawning and
 * tracked prompt actions. Naming needs the harness's existing authentication
 * and model access without attaching to the user's interactive session or
 * gaining permission to modify the repository. Codex and Claude suppress
 * persistence; OpenCode currently offers only its isolated `--pure` run.
 */
import type {
  NamingConfig,
  NamingReasoningEffort,
} from "../config.ts";
import { run } from "../proc.ts";
import { readPrimaryHarness } from "./primary.ts";
import type { HarnessId } from "./types.ts";

export type HarnessCompletion = {
  harnessId: HarnessId;
  argv: string[];
  input?: string;
};

function claudeEffort(
  effort: NamingReasoningEffort,
): Exclude<NamingReasoningEffort, "minimal"> {
  return effort === "minimal" ? "low" : effort;
}

/**
 * Pure command builder kept exported so every harness's safety and model
 * flags are contract-tested without making a model call.
 */
export function buildHarnessCompletion(
  naming: NamingConfig,
  primary: HarnessId,
  prompt: string,
  cwd: string,
): HarnessCompletion {
  const harnessId = naming.harness === "primary" ? primary : naming.harness;
  const model = naming.models[harnessId];
  switch (harnessId) {
    case "claude":
      return {
        harnessId,
        argv: [
          "claude",
          "-p",
          "--safe-mode",
          "--permission-mode",
          "dontAsk",
          "--tools",
          "",
          "--disable-slash-commands",
          "--no-session-persistence",
          "--output-format",
          "text",
          ...(model ? ["--model", model] : []),
          "--effort",
          claudeEffort(naming.reasoningEffort),
        ],
        input: prompt,
      };
    case "codex":
      return {
        harnessId,
        argv: [
          "codex",
          "exec",
          "--ephemeral",
          "--sandbox",
          "read-only",
          "--ignore-rules",
          "--skip-git-repo-check",
          "--color",
          "never",
          "-C",
          cwd,
          ...(model ? ["--model", model] : []),
          "--config",
          `model_reasoning_effort="${naming.reasoningEffort}"`,
          "-",
        ],
        input: prompt,
      };
    case "opencode":
      return {
        harnessId,
        argv: [
          "opencode",
          "run",
          "--pure",
          "--format",
          "default",
          "--dir",
          cwd,
          ...(model ? ["--model", model] : []),
          "--variant",
          naming.reasoningEffort,
          "--",
          prompt,
        ],
      };
  }
}

export async function runHarnessCompletion(
  naming: NamingConfig,
  prompt: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const completion = buildHarnessCompletion(
    naming,
    readPrimaryHarness(),
    prompt,
    cwd,
  );
  const result = await run(completion.argv, {
    cwd,
    ...(completion.input !== undefined ? { input: completion.input } : {}),
    timeoutMs: naming.timeoutMs,
    signal,
  });
  if (signal?.aborted) throw new Error("naming request aborted");
  if (result.timedOut) {
    throw new Error(
      `${completion.harnessId} naming timed out after ${naming.timeoutMs}ms`,
    );
  }
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim() ||
      `exit ${result.exitCode}`)
      .replace(/\s+/g, " ")
      .slice(0, 300);
    throw new Error(`${completion.harnessId} naming failed: ${detail}`);
  }
  const output = result.stdout.trim();
  if (!output) {
    throw new Error(`${completion.harnessId} naming returned no content`);
  }
  return output;
}
