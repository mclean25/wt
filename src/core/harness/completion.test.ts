import { describe, expect, test } from "bun:test";

import type { NamingConfig } from "../config.ts";
import { buildHarnessCompletion } from "./completion.ts";

const naming = (
  overrides: Partial<NamingConfig> = {},
): NamingConfig => ({
  harness: "primary",
  models: {
    claude: "cheap-claude",
    codex: "cheap-codex",
    opencode: "provider/cheap-opencode",
  },
  reasoningEffort: "low",
  maxInputTokens: 8000,
  timeoutMs: 120_000,
  ...overrides,
});

describe("buildHarnessCompletion", () => {
  test("resolves primary to an ephemeral read-only Codex run", () => {
    const out = buildHarnessCompletion(naming(), "codex", "name this", "/repo");
    expect(out.harnessId).toBe("codex");
    expect(out.input).toBe("name this");
    expect(out.argv).toEqual([
      "codex", "exec", "--ephemeral", "--sandbox", "read-only",
      "--ignore-rules", "--skip-git-repo-check", "--color", "never",
      "-C", "/repo", "--model", "cheap-codex",
      "--config", 'model_reasoning_effort="low"', "-",
    ]);
  });

  test("Claude disables tools and persistence", () => {
    const out = buildHarnessCompletion(
      naming({ harness: "claude", reasoningEffort: "minimal" }),
      "codex",
      "name this",
      "/repo",
    );
    expect(out.argv).toContain("--safe-mode");
    expect(out.argv).toContain("--no-session-persistence");
    expect(out.argv).toContain("--tools");
    expect(out.argv.slice(-2)).toEqual(["--effort", "low"]);
  });

  test("OpenCode uses its pure one-shot runner and variant", () => {
    const out = buildHarnessCompletion(
      naming({ harness: "opencode", reasoningEffort: "high" }),
      "claude",
      "name this",
      "/repo",
    );
    expect(out.argv).toEqual([
      "opencode", "run", "--pure", "--format", "default", "--dir", "/repo",
      "--model", "provider/cheap-opencode", "--variant", "high", "--", "name this",
    ]);
    expect(out.input).toBeUndefined();
  });

  test("omits a model override when config leaves it unset", () => {
    const out = buildHarnessCompletion(
      naming({ models: {} }),
      "codex",
      "name this",
      "/repo",
    );
    expect(out.argv).not.toContain("--model");
  });
});
