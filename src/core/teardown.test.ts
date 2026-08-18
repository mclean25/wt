import { expect, test } from "bun:test";

import { resolveTeardownCommand } from "./teardown.ts";

// The shared resolver behind `[lifecycle] destroy_command` and
// `[dev_server] stop_command`.

test("resolveTeardownCommand substitutes path, slug and port", () => {
  expect(
    resolveTeardownCommand("teardown {{slug}} in {{path}} on {{port}}", {
      path: "/wt/thing",
      slug: "thing",
      port: 8103,
    }),
  ).toBe("teardown thing in /wt/thing on 8103");
});

test("resolveTeardownCommand substitutes every occurrence, not just the first", () => {
  expect(
    resolveTeardownCommand("a {{slug}} b {{slug}}", { path: "/p", slug: "s", port: null }),
  ).toBe("a s b s");
});

test("resolveTeardownCommand returns null when nothing is configured", () => {
  expect(resolveTeardownCommand(null, { path: "/p", slug: "s", port: 8100 })).toBeNull();
});

// A worktree with no recorded port never started a dev server, so the
// resources a port-derived teardown targets were never created. Running
// the command with an empty substitution would be the worse answer: it
// hands the shell a command with a hole in it.
test("resolveTeardownCommand skips a port-dependent command when no port was allocated", () => {
  expect(
    resolveTeardownCommand("docker stop stack-{{port}}", { path: "/p", slug: "s", port: null }),
  ).toBeNull();
});

test("resolveTeardownCommand still runs a port-independent command with no port", () => {
  expect(
    resolveTeardownCommand("docker rm -f {{slug}}", { path: "/p", slug: "s", port: null }),
  ).toBe("docker rm -f s");
});
