import { describe, expect, test } from "bun:test";

import type { FooterMode } from "../panels/footer.tsx";
import { makeEdit } from "../text-edit.tsx";
import { restoreFailedCreateFooter } from "./footer-input-keys.ts";

const submitted: Extract<FooterMode, { kind: "input" }> = {
  kind: "input",
  prompt: "new:",
  edit: makeEdit("remember-me"),
  purpose: "new",
};

describe("restoreFailedCreateFooter", () => {
  test("restores submitted input when the footer is still idle", () => {
    expect(restoreFailedCreateFooter({ kind: "legend" }, submitted)).toBe(
      submitted,
    );
  });

  test("does not overwrite a later footer interaction", () => {
    const current: Extract<FooterMode, { kind: "input" }> = {
      kind: "input",
      prompt: "issue:",
      edit: makeEdit("COZ-9"),
      purpose: "issue-id",
    };

    expect(restoreFailedCreateFooter(current, submitted)).toBe(current);
  });
});
