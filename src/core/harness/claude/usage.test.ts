import { describe, expect, test } from "bun:test";

import { parseClaudeUsage, windowKey } from "./usage.ts";

const RESET_5H = "2026-08-09T00:40:00.172141+00:00";
const RESET_7D = "2026-08-10T14:00:00.172479+00:00";

describe("parseClaudeUsage — newer limits[] shape", () => {
  test("splits session, account-wide weekly, and scoped weekly", () => {
    const usage = parseClaudeUsage({
      five_hour: null,
      seven_day: null,
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 52,
          resets_at: RESET_5H,
          scope: null,
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 20,
          resets_at: RESET_7D,
          scope: null,
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 21,
          resets_at: RESET_7D,
          scope: { model: { id: null, display_name: "Fable" } },
        },
      ],
    });
    expect(usage?.fiveHour).toEqual({
      utilization: 52,
      resetsAt: RESET_5H,
      label: null,
    });
    expect(usage?.sevenDay).toEqual({
      utilization: 20,
      resetsAt: RESET_7D,
      label: null,
    });
    expect(usage?.sevenDayScoped).toEqual([
      { utilization: 21, resetsAt: RESET_7D, label: "Fable" },
    ]);
  });

  test("a scoped weekly does not stand in for the account-wide one", () => {
    // Today's live shape: only a Fable weekly, no weekly_all anywhere.
    const usage = parseClaudeUsage({
      seven_day: null,
      limits: [
        { group: "session", percent: 53, resets_at: RESET_5H, scope: null },
        {
          group: "weekly",
          percent: 21,
          resets_at: RESET_7D,
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });
    expect(usage?.sevenDay).toBeNull();
    expect(usage?.sevenDayScoped).toHaveLength(1);
  });

  test("multiple scoped weeklies come back highest-first", () => {
    const usage = parseClaudeUsage({
      limits: [
        {
          group: "weekly",
          percent: 12,
          scope: { model: { display_name: "Sonnet" } },
        },
        {
          group: "weekly",
          percent: 74,
          scope: { model: { display_name: "Opus" } },
        },
      ],
    });
    expect(usage?.sevenDayScoped.map((p) => p.label)).toEqual([
      "Opus",
      "Sonnet",
    ]);
  });

  test("an inactive window still counts — is_active false is not 'absent'", () => {
    const usage = parseClaudeUsage({
      limits: [
        { group: "session", percent: 5, resets_at: RESET_5H, is_active: false },
      ],
    });
    expect(usage?.fiveHour?.utilization).toBe(5);
  });
});

describe("parseClaudeUsage — older flat shape", () => {
  test("reads five_hour / seven_day", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 42.7, resets_at: RESET_5H },
      seven_day: { utilization: 63.2, resets_at: RESET_7D },
    });
    expect(usage?.fiveHour?.utilization).toBe(42.7);
    expect(usage?.sevenDay?.utilization).toBe(63.2);
    expect(usage?.sevenDayScoped).toEqual([]);
  });

  test("per-model weeklies land in sevenDayScoped with their labels", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 12, resets_at: RESET_5H },
      seven_day: null,
      seven_day_opus: { utilization: 81, resets_at: RESET_7D },
      seven_day_sonnet: { utilization: 22, resets_at: RESET_7D },
      seven_day_fable: { utilization: 40, resets_at: RESET_7D },
    });
    expect(usage?.sevenDay).toBeNull();
    expect(usage?.sevenDayScoped.map((p) => [p.label, p.utilization])).toEqual([
      ["Opus", 81],
      ["Fable", 40],
      ["Sonnet", 22],
    ]);
  });
});

describe("parseClaudeUsage — the shapes mix", () => {
  test("account-wide weekly stays in flat seven_day while scoped is in limits[]", () => {
    // Seen in the wild: limits[] carries only the scoped row, and dropping
    // the flat fields because limits[] was non-empty would hide the weekly.
    const usage = parseClaudeUsage({
      five_hour: { utilization: 55, resets_at: RESET_5H },
      seven_day: { utilization: 17, resets_at: RESET_7D },
      limits: [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 21,
          resets_at: RESET_7D,
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });
    expect(usage?.fiveHour?.utilization).toBe(55);
    expect(usage?.sevenDay?.utilization).toBe(17);
    expect(usage?.sevenDayScoped[0]?.label).toBe("Fable");
  });

  test("limits[] wins over the flat field within a category", () => {
    const usage = parseClaudeUsage({
      five_hour: { utilization: 99, resets_at: RESET_5H },
      limits: [{ group: "session", percent: 7, resets_at: RESET_5H }],
    });
    expect(usage?.fiveHour?.utilization).toBe(7);
  });

  test("a scoped limits[] row does not suppress the flat seven_day_opus", () => {
    // Only the scoped category came from limits[]; the account-wide one
    // still has to fall back.
    const usage = parseClaudeUsage({
      seven_day: { utilization: 30, resets_at: RESET_7D },
      seven_day_opus: { utilization: 90, resets_at: RESET_7D },
      limits: [
        {
          group: "weekly",
          percent: 21,
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });
    expect(usage?.sevenDay?.utilization).toBe(30);
    // limits[] supplied the scoped category, so seven_day_opus is not merged
    // in on top of it — that would render the same window twice.
    expect(usage?.sevenDayScoped.map((p) => p.label)).toEqual(["Fable"]);
  });
});

describe("parseClaudeUsage — rejection", () => {
  test("missing resets_at is tolerated", () => {
    const usage = parseClaudeUsage({
      limits: [{ group: "session", percent: 4, resets_at: null }],
    });
    expect(usage?.fiveHour).toEqual({
      utilization: 4,
      resetsAt: null,
      label: null,
    });
  });

  test("entries with a non-numeric percent are skipped", () => {
    expect(
      parseClaudeUsage({ limits: [{ group: "session", percent: null }] }),
    ).toBeNull();
  });

  test("a blank display_name counts as account-wide, not scoped", () => {
    const usage = parseClaudeUsage({
      limits: [
        {
          group: "weekly",
          percent: 8,
          scope: { model: { display_name: "  " } },
        },
      ],
    });
    expect(usage?.sevenDay?.utilization).toBe(8);
    expect(usage?.sevenDayScoped).toEqual([]);
  });

  test("a payload with no windows at all is null", () => {
    expect(parseClaudeUsage({ five_hour: null, seven_day: null })).toBeNull();
    expect(parseClaudeUsage({})).toBeNull();
    expect(parseClaudeUsage(null)).toBeNull();
    expect(parseClaudeUsage("nope")).toBeNull();
  });
});

describe("windowKey", () => {
  test("session and account-wide weekly", () => {
    expect(windowKey({ utilization: 0, resetsAt: null }, false)).toBe("5h");
    expect(windowKey({ utilization: 0, resetsAt: null, label: null }, true)).toBe(
      "7d",
    );
  });

  test("scoped weekly uses the model initial", () => {
    const key = (label: string) =>
      windowKey({ utilization: 0, resetsAt: null, label }, true);
    expect(key("Fable")).toBe("7f");
    expect(key("Opus")).toBe("7o");
    expect(key("Sonnet")).toBe("7s");
  });

  test("a family-prefixed display name keys off the last word", () => {
    // Seen in the wild as "Claude 3.5 Fable".
    expect(
      windowKey(
        { utilization: 0, resetsAt: null, label: "Claude 3.5 Fable" },
        true,
      ),
    ).toBe("7f");
  });
});
