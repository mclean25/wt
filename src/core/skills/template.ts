/**
 * Pure text layer for managed skills/instructions: template-variable
 * rendering, content hashing, the managed-file stamp, and the managed
 * instructions block. No filesystem access — everything here is
 * unit-testable with plain strings (see template.test.ts).
 */
import { createHash } from "node:crypto";

import type { TemplateVar } from "./registry.ts";

/** Short content hash used in stamps, markers, and decline memory. */
export function contentHash(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/**
 * Substitute declared `{{key}}` placeholders. Only DECLARED vars are
 * replaced — any other `{{…}}` in the content (code samples, harness
 * syntax) passes through untouched. An empty answer falls back to the
 * var's `fallback` text, so a skipped question still renders something
 * coherent rather than a hole.
 *
 * Substituted values get HTML-comment delimiters stripped: the stamp
 * and instructions-block markers below are comments, so an answer
 * containing `-->`/`<!--` could otherwise forge or truncate a managed
 * region (defense-in-depth — answers are prose and have no legitimate
 * use for comment syntax).
 */
export function renderTemplate(
  src: string,
  vars: readonly TemplateVar[],
  answers: Record<string, string>,
): string {
  let out = src;
  for (const v of vars) {
    const answer = (answers[v.key] ?? "").trim();
    const value = (answer !== "" ? answer : v.fallback).replace(/<!--|-->/g, "");
    out = out.replaceAll(`{{${v.key}}}`, value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Managed-file stamp (whole-file units: installed SKILL.md copies)
// ---------------------------------------------------------------------------

/**
 * Trailing marker appended to every file `wt skills` installs. The hash
 * is of the body ABOVE the stamp, which makes three states computable
 * from the installed file alone:
 *   body == expected               → fresh
 *   stamp == hash(body) != expected → outdated (our old version, safe to update)
 *   stamp != hash(body), or absent  → modified/unmanaged (never clobber silently)
 */
const STAMP_RE = /<!-- wt-managed ([0-9a-f]{12}) -->\n?$/;

/**
 * Every stamped/compared body carries exactly one trailing newline.
 * CRLF is normalized to LF first — bundled sources are LF-only, and a
 * CRLF variant of the same text must not read as different content.
 */
export function normalizeBody(s: string): string {
  return `${s.replace(/\r\n/g, "\n").replace(/\n+$/, "")}\n`;
}

export function stampContent(body: string): string {
  const b = normalizeBody(body);
  return `${b}<!-- wt-managed ${contentHash(b)} -->\n`;
}

export function splitStamp(text: string): { body: string; stamp: string | null } {
  const m = text.match(STAMP_RE);
  if (!m) return { body: text, stamp: null };
  return { body: text.slice(0, m.index!), stamp: m[1]! };
}

// ---------------------------------------------------------------------------
// Managed instructions block (region inside a user-owned instructions file)
// ---------------------------------------------------------------------------

const BLOCK_BEGIN = (hash: string) =>
  `<!-- wt:instructions:begin ${hash} (managed by \`wt skills\`; edits inside are overwritten) -->`;
const BLOCK_END = "<!-- wt:instructions:end -->";
const BLOCK_RE =
  /<!-- wt:instructions:begin ([0-9a-f]{12})[^>]*-->\n([\s\S]*?)\n<!-- wt:instructions:end -->/;

export function extractInstructionsBlock(
  fileText: string,
): { hash: string; body: string } | null {
  const m = fileText.match(BLOCK_RE);
  if (!m) return null;
  return { hash: m[1]!, body: m[2]! };
}

/**
 * A file should carry at most ONE managed block; a duplicate (manual
 * copy/paste, file merge) would silently escape management since
 * extract/splice only ever operate on the first. Detection reports
 * such a file as modified instead.
 */
export function countInstructionsBlocks(fileText: string): number {
  return fileText.match(new RegExp(BLOCK_RE.source, "g"))?.length ?? 0;
}

/**
 * Replace the managed block in `fileText` (or append one at the end,
 * blank-line separated) with `blockBody`. Idempotent: splicing the same
 * body twice yields identical output.
 */
export function spliceInstructionsBlock(fileText: string, blockBody: string): string {
  const body = blockBody.replace(/\n+$/, "");
  const block = `${BLOCK_BEGIN(contentHash(body))}\n${body}\n${BLOCK_END}`;
  if (BLOCK_RE.test(fileText)) return fileText.replace(BLOCK_RE, block);
  if (fileText.trim() === "") return `${block}\n`;
  const sep = fileText.endsWith("\n\n") ? "" : fileText.endsWith("\n") ? "\n" : "\n\n";
  return `${fileText}${sep}${block}\n`;
}

// ---------------------------------------------------------------------------
// Frontmatter transform for native (non-rulesync) installs
// ---------------------------------------------------------------------------

/**
 * Strip the rulesync-only `targets:` block from a SKILL.md's
 * frontmatter so a native install carries clean Claude/Codex
 * frontmatter. No-op when absent. Other keys (name, description,
 * argument-hint, user_invocable) are kept — Claude reads them and
 * Codex tolerates them.
 */
export function stripRulesyncKeys(md: string): string {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return md;
  const out: string[] = [];
  let skipping = false;
  for (const line of m[1]!.split("\n")) {
    if (skipping) {
      if (/^\s+\S/.test(line)) continue;
      skipping = false;
    }
    if (/^targets:/.test(line)) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return `---\n${out.join("\n")}\n---\n${m[2]}`;
}
