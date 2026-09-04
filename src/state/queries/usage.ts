import { queryOptions } from "@tanstack/react-query";

import {
  readClaudeUsage,
  type ClaudeUsage,
} from "../../core/harness/claude/usage.ts";
import {
  readCodexUsage,
  type CodexUsage,
} from "../../core/harness/codex/usage.ts";
import { qk } from "../keys.ts";
import { operationErrors, runQuery } from "./boundary.ts";

const io = operationErrors("usage");

/**
 * Anthropic API utilization read from the Claude Code statusline's
 * cache file (~/.cache/claude-statusline-usage.json). The statusline
 * is the only thing that hits the API; we just observe its cache, so
 * there's no auth or rate-limit concern here. Refetch every minute so
 * the title bar trails the cache by at most ~60s.
 */
export const claudeUsageQuery = () =>
  queryOptions({
    queryKey: qk.claudeUsage(),
    queryFn: ({ signal }): Promise<ClaudeUsage | null> =>
      runQuery(io.sync("read Claude usage", () => readClaudeUsage()), signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

/**
 * Codex rate-limit usage (5h/7d %), parsed from the newest rollout's
 * latest `token_count` event. No HTTP — purely on-disk. Same cadence as
 * the claude usage read; gated to the codex primary at the call site.
 */
export const codexUsageQuery = () =>
  queryOptions({
    queryKey: qk.codexUsage(),
    queryFn: ({ signal }): Promise<CodexUsage | null> =>
      runQuery(io.sync("read Codex usage", () => readCodexUsage()), signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
