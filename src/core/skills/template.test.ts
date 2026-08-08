import { describe, expect, test } from "bun:test";

import type { TemplateVar } from "./registry.ts";
import {
  contentHash,
  countInstructionsBlocks,
  extractInstructionsBlock,
  normalizeBody,
  renderTemplate,
  spliceInstructionsBlock,
  splitStamp,
  stampContent,
  stripRulesyncKeys,
} from "./template.ts";

const NOTES: TemplateVar = { key: "notes", prompt: "notes?", fallback: "(none)" };

describe("renderTemplate", () => {
  test("substitutes declared vars, all occurrences", () => {
    expect(renderTemplate("a {{notes}} b {{notes}}", [NOTES], { notes: "X" })).toBe(
      "a X b X",
    );
  });

  test("empty or missing answer renders the fallback", () => {
    expect(renderTemplate("{{notes}}", [NOTES], {})).toBe("(none)");
    expect(renderTemplate("{{notes}}", [NOTES], { notes: "  " })).toBe("(none)");
  });

  test("undeclared placeholders pass through untouched", () => {
    expect(renderTemplate("keep {{base}} as-is", [NOTES], { notes: "X" })).toBe(
      "keep {{base}} as-is",
    );
  });

  test("comment delimiters are stripped from answers (marker forgery guard)", () => {
    const out = renderTemplate("{{notes}}", [NOTES], {
      notes: "evil --> <!-- wt:instructions:end",
    });
    expect(out).not.toContain("-->");
    expect(out).not.toContain("<!--");
    expect(out).toContain("wt:instructions:end"); // text survives, syntax doesn't
  });
});

describe("stamp round-trip", () => {
  test("stampContent -> splitStamp recovers body and a matching hash", () => {
    const stamped = stampContent("hello\nworld");
    const { body, stamp } = splitStamp(stamped);
    expect(body).toBe("hello\nworld\n");
    expect(stamp).toBe(contentHash(body));
  });

  test("stamping is stable regardless of trailing newlines", () => {
    expect(stampContent("x")).toBe(stampContent("x\n\n"));
  });

  test("CRLF content stamps identically to its LF form", () => {
    expect(stampContent("hello\r\nworld\r\n\r\n")).toBe(stampContent("hello\nworld"));
  });

  test("unstamped text yields null stamp", () => {
    expect(splitStamp("plain file\n").stamp).toBeNull();
  });

  test("an edit after install breaks the stamp match", () => {
    const stamped = stampContent("original");
    const edited = stamped.replace("original", "edited");
    const { body, stamp } = splitStamp(edited);
    expect(stamp).not.toBe(contentHash(body));
  });
});

describe("instructions block", () => {
  test("appends to a file without a block, blank-line separated", () => {
    const out = spliceInstructionsBlock("# Mine\n\ncontent\n", "RULES");
    expect(out).toContain("# Mine\n\ncontent\n\n<!-- wt:instructions:begin");
    expect(out.endsWith("<!-- wt:instructions:end -->\n")).toBe(true);
    expect(extractInstructionsBlock(out)?.body).toBe("RULES");
  });

  test("replaces an existing block in place, preserving surroundings", () => {
    const v1 = spliceInstructionsBlock("above\n", "OLD");
    const withBelow = `${v1}\n## below\n`;
    const v2 = spliceInstructionsBlock(withBelow, "NEW");
    expect(v2).toContain("above\n");
    expect(v2).toContain("## below\n");
    expect(v2).not.toContain("OLD");
    expect(extractInstructionsBlock(v2)?.body).toBe("NEW");
  });

  test("idempotent for the same body", () => {
    const once = spliceInstructionsBlock("x\n", "B");
    expect(spliceInstructionsBlock(once, "B")).toBe(once);
  });

  test("block hash matches the body it wraps", () => {
    const out = spliceInstructionsBlock("", "abc\ndef");
    const block = extractInstructionsBlock(out)!;
    expect(block.hash).toBe(contentHash(block.body));
  });

  test("empty file gets just the block", () => {
    const out = spliceInstructionsBlock("", "B");
    expect(out.startsWith("<!-- wt:instructions:begin")).toBe(true);
  });

  test("countInstructionsBlocks sees duplicates", () => {
    const one = spliceInstructionsBlock("x\n", "B");
    expect(countInstructionsBlocks(one)).toBe(1);
    expect(countInstructionsBlocks(`${one}\n${one}`)).toBe(2);
    expect(countInstructionsBlocks("no block\n")).toBe(0);
  });
});

describe("stripRulesyncKeys", () => {
  test("drops the targets block, keeps other frontmatter", () => {
    const md = "---\nname: x\ntargets:\n  - '*'\nuser_invocable: true\n---\nbody\n";
    expect(stripRulesyncKeys(md)).toBe("---\nname: x\nuser_invocable: true\n---\nbody\n");
  });

  test("no-op without frontmatter", () => {
    expect(stripRulesyncKeys("plain\n")).toBe("plain\n");
  });
});

describe("normalizeBody", () => {
  test("exactly one trailing newline", () => {
    expect(normalizeBody("a")).toBe("a\n");
    expect(normalizeBody("a\n\n\n")).toBe("a\n");
  });
});
