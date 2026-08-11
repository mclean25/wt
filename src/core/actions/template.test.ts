import { expect, test } from "bun:test";

import { applyVars } from "./template.ts";

test("substitutes provided vars and passes unknown ones through", () => {
  expect(applyVars("on {{branch}} at {{nope}}", { branch: "feat/x" })).toBe(
    "on feat/x at {{nope}}",
  );
});

test("{{today}} resolves without any caller-provided vars", () => {
  const out = applyVars("Today is {{today}}.", {});
  expect(out).not.toContain("{{today}}");
  // Weekday + full date: the shape agents do days-until arithmetic on.
  expect(out).toMatch(/^Today is \w+day, \w+ \d{1,2}, \d{4}\.$/);
});

test("an explicit var beats the builtin of the same name", () => {
  expect(applyVars("{{today}}", { today: "pinned" })).toBe("pinned");
});
