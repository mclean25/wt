import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { theme } from "./theme.ts";
import { attachLoggerToasts, getToast, showToast, toastColor, toastDuration } from "./toast.ts";

// `ToastStore`'s expiry fiber runs on the real Clock (see toast.ts), so
// this waits in real time too — an Effect construct rather than a bare
// `new Promise`, but not a TestClock seam (not worth one for a handful
// of sub-100ms waits; see the auto-merge-retry.ts comment for where
// that seam earns its keep).
const tick = (ms: number) => Effect.runPromise(Effect.sleep(`${ms} millis`));

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

  test("detach rejects late direct toasts until the next TUI attach", () => {
    const detach = attachLoggerToasts();
    showToast("before detach", theme.ok, 1_000);
    detach();
    showToast("late completion", theme.warn, 1_000);
    expect(getToast()).toBeNull();

    const detachAgain = attachLoggerToasts();
    showToast("next run", theme.ok, 1_000);
    expect(getToast()?.text).toBe("next run");
    detachAgain();
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
