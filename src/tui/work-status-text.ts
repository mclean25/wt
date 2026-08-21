/**
 * Recovering the SHAPE of a work-status record's free text.
 *
 * Both fields here are written to a prescribed shape by the agent
 * contract in `skills/instructions.md`, and both arrive at the
 * renderer as one flat run-on line: `sanitizeWorkNote` collapses every
 * whitespace run to a single space, which is right (notes reach
 * osascript, log lines and terminal titles, so raw control bytes are a
 * real injection vector) and destroys the line structure on the way
 * past. The labels themselves survive, so the structure is recoverable
 * at RENDER time without touching the write path — which is the whole
 * reason to do it here rather than by keeping newlines in the store.
 *
 * Everything below degrades to "one unstructured block", the exact
 * rendering these fields had before, whenever the shape isn't there.
 * A note written by a human at the `u` picker is not required to have
 * one, so absence has to be ordinary rather than a parse failure.
 */
/**
 * The four labels the ready-note shape prescribes, longest first so a
 * prefix can never shadow a longer sibling in the alternation.
 */
const NOTE_LABELS = ["IF WRONG", "UNTESTED", "REVERT", "OPS"] as const;

const NOTE_LABEL_RE = new RegExp(`\\s*(?=(?:${NOTE_LABELS.join("|")}):\\s)`, "g");

export type NoteSection = {
  /** `null` for the lead line — what changes, in user terms. */
  label: string | null;
  body: string;
};

/**
 * Split a ready note into its lead line plus whichever of the four
 * labelled sections it carries.
 *
 * Matched case-sensitively against the exact labels: the shape spells
 * them in caps, and a loose match would happily cut a note in half on
 * the word "ops" in a sentence. A note with no labels comes back as a
 * single unlabelled section, so callers never branch on "did this
 * parse".
 */
export function splitNoteSections(note: string): NoteSection[] {
  const trimmed = note.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(NOTE_LABEL_RE).filter((p) => p.trim() !== "");
  return parts.map((part) => {
    const m = part.match(/^([A-Z][A-Z ]*[A-Z]|[A-Z]+):\s*([\s\S]*)$/);
    if (m && (NOTE_LABELS as readonly string[]).includes(m[1]!)) {
      return { label: m[1]!, body: m[2]!.trim() };
    }
    return { label: null, body: part.trim() };
  });
}

/**
 * Whether a `REVERT:` value claims the change backs out cleanly.
 *
 * The shape is `"safe"` or `"no:" + reason`, and this is the line
 * nobody volunteers and the one that decides whether a bad merge costs
 * thirty seconds or an afternoon — worth a colour of its own rather
 * than the uniform body tone. Anything that matches neither opening
 * stays uncoloured: guessing here would be asserting a revert
 * property the note never claimed, and a wrong green is exactly the
 * direction that costs an afternoon.
 */
export function revertVerdict(body: string): "safe" | "unsafe" | null {
  const head = body.trim().toLowerCase();
  if (head.startsWith("safe")) return "safe";
  if (head.startsWith("no:") || head.startsWith("no ")) return "unsafe";
  return null;
}

export type VerifySteps = {
  /** Everything before the first step, verbatim. */
  preamble: string;
  /** Numbered steps, each without its `N.` prefix. */
  steps: string[];
};

/**
 * Runs of `N. ` in `text` that form a real 1..n step list.
 *
 * The consecutive-from-1 requirement is the guard that makes this safe
 * to run on free text: a lone " 3. " inside a sentence, or a version
 * like "2.1" (no space after the dot, so it never matches at all),
 * cannot manufacture a structure the writer didn't intend. Half a
 * parse is worse than none — it would present a fragment of a sentence
 * as step 3 of 3.
 */
function stepOffsets(text: string): number[] {
  const re = /(?:^|\s)(\d{1,2})\.\s/g;
  const offsets: number[] = [];
  let want = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (Number(m[1]) !== want) continue;
    // Point at the digit, not at the whitespace that preceded it.
    offsets.push(m.index + m[0].length - m[1]!.length - 2);
    want += 1;
  }
  return offsets;
}

/**
 * Parse a `verifyAfterMerge` into its preamble and its steps.
 *
 * The field is deliberately verbose — it is an executable contract for
 * an agent that is not the one who wrote it, possibly reading after a
 * compaction — so nothing here rewrites or shortens the text itself.
 * It only finds the seams, so a reader who does not need the steps yet
 * can be shown one line instead of fourteen.
 */
export function parseVerifySteps(text: string): VerifySteps {
  const trimmed = text.trim();
  // A `STEPS:` marker, when present, is the authoritative seam: it is
  // where the writer said the prose stops.
  const marker = trimmed.match(/\bSTEPS:\s*/);
  const region = marker ? trimmed.slice(marker.index! + marker[0].length) : trimmed;
  const before = marker ? trimmed.slice(0, marker.index!).trim() : "";
  const offsets = stepOffsets(region);
  if (offsets.length === 0) {
    return { preamble: trimmed, steps: [] };
  }
  const steps: string[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i]!;
    const end = i + 1 < offsets.length ? offsets[i + 1]! : region.length;
    steps.push(
      region
        .slice(start, end)
        .replace(/^\d{1,2}\.\s*/, "")
        .trim(),
    );
  }
  const preamble = (before || region.slice(0, offsets[0]!)).trim();
  return { preamble, steps };
}
