import { expect, test } from "bun:test";
import { actionGroupsLast } from "./action-group-order.ts";

test("default preserves groups, configured groups move intact to the bottom", () => {
  const groups = new Map([["agent", ["u", "g"]], ["dev server", ["d", "s", "l"]], ["checks", ["t"]]]);
  expect(actionGroupsLast(groups, [])).toEqual(["u", "g", "d", "s", "l", "t"]);
  expect(actionGroupsLast(groups, ["missing", "dev server", "dev server"])).toEqual(["u", "g", "t", "d", "s", "l"]);
  expect(actionGroupsLast(groups, ["dev server"], ["m"])).toEqual(["u", "g", "t", "m", "d", "s", "l"]);
});
