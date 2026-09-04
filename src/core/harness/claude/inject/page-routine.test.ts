import { describe, expect, test } from "bun:test";

import { PAGE_ROUTINE } from "./page-routine.ts";

type Fiber = {
  memoizedProps: Record<string, unknown>;
  child?: Fiber | null;
  sibling?: Fiber | null;
  alternate?: Fiber | null;
  return?: Fiber | null;
};

const routine = Function(`return (${PAGE_ROUTINE})`)() as (
  this: { _reactInternals: Fiber },
  message: string,
  probeOnly: boolean,
) => string;

function tree(promptProps: Record<string, unknown>) {
  const submitted: string[] = [];
  const input: Fiber = {
    memoizedProps: {
      value: "",
      cursorOffset: 0,
      onChange() {},
      onChangeCursorOffset() {},
    },
  };
  const prompt: Fiber = {
    memoizedProps: {
      ...promptProps,
      onSubmit(message: string) {
        submitted.push(message);
      },
    },
    child: input,
  };
  const root: Fiber = { memoizedProps: {}, child: prompt };
  prompt.return = root;
  input.return = prompt;
  return { app: { _reactInternals: root }, submitted };
}

describe("Claude page routine prompt anchors", () => {
  test("finds the Claude 2.1.260 draft/transcript/scope prompt", () => {
    const { app, submitted } = tree({ draft: {}, transcript: {}, scope: {} });

    expect(JSON.parse(routine.call(app, "", true))).toMatchObject({
      ok: true,
      foundPrompt: true,
      foundInput: true,
      foundCaret: true,
    });
    expect(JSON.parse(routine.call(app, "queued work", false))).toMatchObject({
      ok: true,
      submitted: true,
    });
    expect(submitted).toEqual(["queued work"]);
  });

  test("keeps the pre-2.1.260 prompt anchor compatible", () => {
    const { app } = tree({ messagesRef: {} });
    expect(JSON.parse(routine.call(app, "", true))).toMatchObject({
      ok: true,
      foundPrompt: true,
      foundInput: true,
    });
  });
});
