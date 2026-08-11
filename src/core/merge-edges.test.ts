import { describe, expect, test } from "bun:test";

import {
  edgeIsStaleBySha,
  edgeIsStaleByTime,
  parseMergeEdge,
  topoOrderSlugs,
  type MergeEdge,
} from "./merge-edges.ts";

function edge(partial: Partial<MergeEdge>): MergeEdge {
  return {
    from: "a",
    to: "b",
    kind: "before",
    strength: "prefer",
    at: "2026-08-10T12:00:00.000Z",
    by: "fleet",
    fromSha: "aaa",
    toSha: "bbb",
    ...partial,
  };
}

describe("topoOrderSlugs", () => {
  test("no applicable edges keeps order identical", () => {
    expect(topoOrderSlugs(["a", "b", "c"], [])).toEqual(["a", "b", "c"]);
    // conflicts never orders
    expect(
      topoOrderSlugs(["a", "b"], [edge({ from: "b", to: "a", kind: "conflicts" })]),
    ).toEqual(["a", "b"]);
  });

  test("reorders a violated before-edge, minimally", () => {
    expect(
      topoOrderSlugs(["x", "b", "a", "y"], [edge({ from: "a", to: "b" })]),
    ).toEqual(["x", "a", "b", "y"]);
  });

  test("already-satisfied edge changes nothing", () => {
    expect(
      topoOrderSlugs(["a", "b", "c"], [edge({ from: "a", to: "c" })]),
    ).toEqual(["a", "b", "c"]);
  });

  test("enables orders like before", () => {
    expect(
      topoOrderSlugs(["b", "a"], [edge({ from: "a", to: "b", kind: "enables" })]),
    ).toEqual(["a", "b"]);
  });

  test("chains resolve transitively", () => {
    expect(
      topoOrderSlugs(
        ["c", "b", "a"],
        [edge({ from: "a", to: "b" }), edge({ from: "b", to: "c" })],
      ),
    ).toEqual(["a", "b", "c"]);
  });

  test("cycle degrades to incoming order instead of stalling", () => {
    expect(
      topoOrderSlugs(
        ["a", "b"],
        [edge({ from: "a", to: "b" }), edge({ from: "b", to: "a" })],
      ),
    ).toEqual(["a", "b"]);
  });

  test("edges naming absent slugs are ignored", () => {
    expect(
      topoOrderSlugs(["b", "a"], [edge({ from: "ghost", to: "b" })]),
    ).toEqual(["b", "a"]);
  });
});

describe("staleness", () => {
  test("fresh while both HEADs match their anchors", () => {
    const e = edge({});
    expect(
      edgeIsStaleBySha(e, (s) => (s === "a" ? "aaa" : "bbb")),
    ).toBe(false);
  });

  test("stale once either endpoint moves", () => {
    const e = edge({});
    expect(edgeIsStaleBySha(e, (s) => (s === "a" ? "moved" : "bbb"))).toBe(true);
    expect(edgeIsStaleBySha(e, (s) => (s === "a" ? "aaa" : "moved"))).toBe(true);
  });

  test("missing anchors are stale immediately; unresolvable HEAD is not", () => {
    expect(edgeIsStaleBySha(edge({ fromSha: undefined }), () => "aaa")).toBe(true);
    expect(edgeIsStaleBySha(edge({}), () => null)).toBe(false);
  });

  test("time-based: a commit after the assert stales it", () => {
    const at = Date.parse("2026-08-10T12:00:00.000Z");
    expect(edgeIsStaleByTime(edge({}), () => at - 60_000)).toBe(false);
    expect(edgeIsStaleByTime(edge({}), () => at + 60_000)).toBe(true);
    expect(edgeIsStaleByTime(edge({}), () => null)).toBe(false);
    expect(edgeIsStaleByTime(edge({ fromSha: undefined }), () => null)).toBe(true);
  });
});

describe("parseMergeEdge", () => {
  test("round-trips a full edge", () => {
    const e = edge({ why: "contained change first" });
    expect(parseMergeEdge(JSON.parse(JSON.stringify(e)))).toEqual(e);
  });

  test("drops garbage, self-edges, unknown kinds", () => {
    expect(parseMergeEdge(null)).toBeNull();
    expect(parseMergeEdge({ from: "a", to: "a", kind: "before" })).toBeNull();
    expect(parseMergeEdge({ from: "a", to: "b", kind: "banana" })).toBeNull();
  });

  test("defaults strength to prefer and by to fleet", () => {
    const parsed = parseMergeEdge({ from: "a", to: "b", kind: "before" });
    expect(parsed?.strength).toBe("prefer");
    expect(parsed?.by).toBe("fleet");
  });
});
