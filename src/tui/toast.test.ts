import { describe, expect, test } from "bun:test";

import { theme } from "./theme.ts";
import { getToast, showToast, toastColor, toastDuration } from "./toast.ts";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("toast store", () => {
  test("show → visible, expires after ms", async () => {
    showToast("hello", theme.ok, 40);
    expect(getToast()?.text).toBe("hello");
    expect(getToast()?.color).toBe(theme.ok);
    await tick(70);
    expect(getToast()).toBeNull();
  });

  test("latest wins and resets the clock", async () => {
    showToast("first", theme.ok, 40);
    await tick(25);
    showToast("second", theme.warn, 60);
    expect(getToast()?.text).toBe("second");
    // The first toast's 40ms deadline passing must not clear the second.
    await tick(30);
    expect(getToast()?.text).toBe("second");
    await tick(50);
    expect(getToast()).toBeNull();
  });
});

describe("level mapping", () => {
  test("colors follow the theme", () => {
    expect(toastColor("ok")).toBe(theme.ok);
    expect(toastColor("warn")).toBe(theme.warn);
    expect(toastColor("err")).toBe(theme.err);
    expect(toastColor("info")).toBe(theme.info);
    expect(toastColor("dim")).toBe(theme.fgDim);
  });

  test("errors linger longer than acks", () => {
    expect(toastDuration("err")).toBeGreaterThan(toastDuration("warn"));
    expect(toastDuration("warn")).toBeGreaterThan(toastDuration("ok"));
  });
});
