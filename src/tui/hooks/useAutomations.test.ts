import { describe, expect, test } from "bun:test";

import type { AutomationFire } from "../automation-rules.ts";
import { canQueueActionFire, isBreakerExemptFire } from "./useAutomations.ts";

const fire = (on: AutomationFire["rule"]["on"]): AutomationFire =>
  ({
    rule: { on, run: "custom-action" },
    frozenVars: null,
  }) as AutomationFire;

describe("automation breaker policy", () => {
  test("a fleet branch move bypasses the breaker regardless of the configured action", () => {
    expect(isBreakerExemptFire(fire("branch.advanced"), false)).toBe(true);
  });

  test("a repeated worktree remediation remains breaker guarded", () => {
    expect(isBreakerExemptFire(fire("pr.checks.failed"), false)).toBe(false);
  });
});

describe("automation action eligibility", () => {
  const created = { ...fire("wt.created"), slug: "issue-less" };
  const row = (issueId: string | null) => ({
    slug: "issue-less",
    issueId,
    pr: undefined,
    deployed: false,
  });

  test("issue-less creation does not occupy the queue, but attaching an issue makes it eligible", () => {
    expect(canQueueActionFire(created, ["issue.tracker"], row(null))).toBe(false);
    expect(canQueueActionFire(created, ["issue.tracker"], row("COZ-123"))).toBe(true);
  });

  test("missing mutable preconditions do not occupy the queue", () => {
    expect(canQueueActionFire(created, ["pr.ready"], row("COZ-123"))).toBe(false);
    expect(canQueueActionFire(created, [], row(null))).toBe(true);
  });

  test("frozen post-merge fires remain queued for terminal skip handling", () => {
    const frozen = { ...created, frozenVars: { issue_id: "" } } as AutomationFire;
    expect(canQueueActionFire(frozen, ["issue.tracker"], undefined)).toBe(true);
  });
});
