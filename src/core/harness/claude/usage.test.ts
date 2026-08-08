import { describe, expect, test } from "bun:test";

import { parseClaudeUsage } from "./usage.ts";

const RESET_5H = "2026-08-09T00:40:00.172141+00:00";
const RESET_7D = "2026-08-10T14:00:00.172479+00:00";

/** Newer shape: `limits[]`, weekly scoped to a single model. */
function limitsPayload(limits: unknown[]) {
  return { five_hour: null, seven_day: null, limits };
}

describe("parseClaudeUsage — newer limits[] shape", () => {
  test("reads both windows and the weekly scope label", () => {
    const usage = parseClaudeUsage(
      limitsPayload([
        {
          kind: "session",
          group: "session",
          percent: 1,
          resets_at: RESET_5H,
          scope: null,
          is_active: false,
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 3,
          resets_at: RESET_7D,
          scope: { model: { id: null, display_name: "Fable" } },
          is_active: true,
        },
      ]),
    );
    expect(usage).toEqual({
      fiveHour: { utilization: 1, resetsAt: RESET_5H, label: null },
      sevenDay: { utilization: 3, resetsAt: RESET_7D, label: "Fable" },
    });
  });

  test("several scoped weeklies: the highest percentage wins", () => {
    const usage = parseClaudeUsage(
      limitsPayload([
        {
          group: "weekly",
          percent: 12,
          resets_at: RESET_7D,
          scope: { model: { display_name: "Sonnet" } },
        },
        {
          group: "weekly",
          percent: 74,
          resets_at: RESET_7D,
          scope: { model: { display_name: "Opus" } },
        },
      ]),
    );
    expect(usage?.sevenDay).toEqual({
      utilization: 74,
      resetsAt: RESET_7D,
      label: "Opus",
    });
  });

  test("an inactive window still counts — is_active false is not 'absent'", () => {
    const usage = parseClaudeUsage(
      limitsPayload([
        { group: "session", percent: 5, resets_at: RESET_5H, is_active: false },
      ]),
    );
    expect(usage?.fiveHour?.utilization).toBe(5);
  });

  test("a missing weekly leaves the 5h window intact", () => {
    const usage = parseClaudeUsage(
      limitsPayload([{ group: "session", percent: 5, resets_at: RESET_5H }]),
    );
    expect(usage?.fiveHour?.utilization).toBe(5);
    expect(usage?.sevenDay).toBeNull();
  });
});

describe("parseClaudeUsage — older flat shape", () => {
  test("reads five_hour / seven_day", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 42.7, resets_at: RESET_5H },
      seven_day: { utilization: 63.2, resets_at: RESET_7D },
    });
    expect(usage).toEqual({
      fiveHour: { utilization: 42.7, resetsAt: RESET_5H, label: null },
      sevenDay: { utilization: 63.2, resetsAt: RESET_7D, label: null },
    });
  });

  test("per-model weeklies fall back with their labels, highest wins", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 12, resets_at: RESET_5H },
      seven_day: null,
      seven_day_opus: { utilization: 81, resets_at: RESET_7D },
      seven_day_sonnet: { utilization: 22, resets_at: RESET_7D },
    });
    expect(usage?.sevenDay).toEqual({
      utilization: 81,
      resetsAt: RESET_7D,
      label: "Opus",
    });
  });

  test("an account-wide seven_day outranks a lower scoped one", () => {
    const usage = parseClaudeUsage({
      seven_day: { utilization: 90, resets_at: RESET_7D },
      seven_day_opus: { utilization: 30, resets_at: RESET_7D },
    });
    expect(usage?.sevenDay?.label).toBeNull();
    expect(usage?.sevenDay?.utilization).toBe(90);
  });
});

describe("parseClaudeUsage — precedence and rejection", () => {
  test("limits[] wins over flat fields when both are present", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 99, resets_at: RESET_5H },
      limits: [{ group: "session", percent: 7, resets_at: RESET_5H }],
    });
    expect(usage?.fiveHour?.utilization).toBe(7);
  });

  test("an empty limits[] falls back to the flat fields", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 99, resets_at: RESET_5H },
      limits: [],
    });
    expect(usage?.fiveHour?.utilization).toBe(99);
  });

  test("missing resets_at is tolerated", () => {
    const usage = parseClaudeUsage(
      limitsPayload([{ group: "session", percent: 4, resets_at: null }]),
    );
    expect(usage?.fiveHour).toEqual({
      utilization: 4,
      resetsAt: null,
      label: null,
    });
  });

  test("entries with a non-numeric percent are skipped", () => {
    expect(
      parseClaudeUsage(limitsPayload([{ group: "session", percent: null }])),
    ).toBeNull();
  });

  test("a payload with neither window is null", () => {
    expect(parseClaudeUsage({ five_hour: null, seven_day: null })).toBeNull();
    expect(parseClaudeUsage({})).toBeNull();
    expect(parseClaudeUsage(null)).toBeNull();
    expect(parseClaudeUsage("nope")).toBeNull();
  });
});
