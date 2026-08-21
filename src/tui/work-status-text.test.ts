import { describe, expect, test } from "bun:test";

import { parseVerifySteps, revertVerdict, splitNoteSections } from "./work-status-text.ts";

/**
 * A real note off the live board, in the flattened single-line form
 * `sanitizeWorkNote` produces. Kept verbatim: the whole claim these
 * helpers make is that the prescribed shape survives that flattening,
 * and a tidied-up fixture would prove nothing about the real input.
 */
const REAL_NOTE =
  "Guest-only meetings get the webhook backstop; guests resolve by the #1415 HMAC " +
  "binding, not by display name. OPS: deploy video-recording-webhook REVERT: safe: " +
  "the uuid overload the old code calls is untouched IF WRONG: guest-only meetings " +
  "never activate when Twilio REST is down UNTESTED: a live Twilio room; callback " +
  "signed locally, not by Twilio";

describe("splitNoteSections", () => {
  test("recovers the prescribed shape from a flattened note", () => {
    const parts = splitNoteSections(REAL_NOTE);
    expect(parts.map((p) => p.label)).toEqual([null, "OPS", "REVERT", "IF WRONG", "UNTESTED"]);
    expect(parts[0]!.body).toBe(
      "Guest-only meetings get the webhook backstop; guests resolve by the #1415 HMAC binding, not by display name.",
    );
    expect(parts[1]!.body).toBe("deploy video-recording-webhook");
    expect(parts[3]!.body).toBe("guest-only meetings never activate when Twilio REST is down");
  });

  test("a note with no labels stays one unlabelled section", () => {
    // Most notes are a single sentence, and a human at the `u` picker
    // is never asked for the shape — absence has to be ordinary.
    const parts = splitNoteSections("Reproducing #1328 cold coach login before implementation");
    expect(parts).toEqual([
      { label: null, body: "Reproducing #1328 cold coach login before implementation" },
    ]);
  });

  test("lower-case prose is not mistaken for a label", () => {
    const parts = splitNoteSections("changed how ops: handles the revert: path");
    expect(parts).toHaveLength(1);
    expect(parts[0]!.label).toBeNull();
  });

  test("a note that opens on a label has no lead section", () => {
    const parts = splitNoteSections("OPS: none REVERT: safe");
    expect(parts.map((p) => p.label)).toEqual(["OPS", "REVERT"]);
  });

  test("empty and whitespace-only notes yield nothing to render", () => {
    expect(splitNoteSections("")).toEqual([]);
    expect(splitNoteSections("   ")).toEqual([]);
  });
});

describe("revertVerdict", () => {
  test("reads the two shapes the contract prescribes", () => {
    expect(revertVerdict("safe")).toBe("safe");
    expect(revertVerdict("safe: the uuid overload is untouched")).toBe("safe");
    expect(revertVerdict("no: the backfill persists")).toBe("unsafe");
  });

  test("declines to guess on anything else", () => {
    // A wrong green here is the direction that costs an afternoon.
    expect(revertVerdict("depends on whether the migration ran")).toBeNull();
    expect(revertVerdict("")).toBeNull();
  });
});

describe("parseVerifySteps", () => {
  const REAL_VERIFY =
    "Only a real Twilio callback can prove this. Local dev holds Twilio TEST credentials " +
    "that cannot reach the Video API (error 20008). STEPS: 1. Confirm the deploy landed " +
    "BEFORE believing any negative. 2. Create a guest-only meeting and open its guest " +
    "link. 3. Assert the ParticipantIdentity is guest_<name>_<epochms>-<16 hex>.";

  test("splits a real field into a preamble and its steps", () => {
    const parsed = parseVerifySteps(REAL_VERIFY);
    expect(parsed.preamble).toBe(
      "Only a real Twilio callback can prove this. Local dev holds Twilio TEST credentials that cannot reach the Video API (error 20008).",
    );
    expect(parsed.steps).toHaveLength(3);
    expect(parsed.steps[0]).toBe("Confirm the deploy landed BEFORE believing any negative.");
    expect(parsed.steps[2]).toBe(
      "Assert the ParticipantIdentity is guest_<name>_<epochms>-<16 hex>.",
    );
  });

  test("finds steps with no STEPS: marker", () => {
    const parsed = parseVerifySteps("Do it on staging. 1. Sign in. 2. Revoke the grant.");
    expect(parsed.preamble).toBe("Do it on staging.");
    expect(parsed.steps).toEqual(["Sign in.", "Revoke the grant."]);
  });

  test("a lone stray number cannot manufacture a step list", () => {
    // Half a parse is worse than none: it would present a sentence
    // fragment as step 3 of 3.
    const parsed = parseVerifySteps("Check the log line, then see section 3. It explains why.");
    expect(parsed.steps).toEqual([]);
    expect(parsed.preamble).toBe("Check the log line, then see section 3. It explains why.");
  });

  test("a decimal is not a step number", () => {
    const parsed = parseVerifySteps("Confirm the client is on 2.1 before starting.");
    expect(parsed.steps).toEqual([]);
  });

  test("prose with no steps keeps its whole text as the preamble", () => {
    const text =
      "Once staging has deployed the sync functions, lease an account and confirm events appear.";
    const parsed = parseVerifySteps(text);
    expect(parsed.steps).toEqual([]);
    expect(parsed.preamble).toBe(text);
  });

  test("steps are found even when numbering restarts mid-text", () => {
    // Only the run that starts at 1 and counts up is taken; the second
    // "1." is prose inside the last step, not a new list.
    const parsed = parseVerifySteps("Go. 1. First thing. 2. Second thing, see rule 1. above.");
    expect(parsed.steps).toEqual(["First thing.", "Second thing, see rule 1. above."]);
  });
});
