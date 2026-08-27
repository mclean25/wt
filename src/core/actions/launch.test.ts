import { describe, expect, test } from "bun:test";

import type { ActionDef, RemoteConfig } from "../config.ts";
import { decodeRemoteArgs } from "../remote-protocol.ts";
import { prepareRemoteAction } from "./launch.ts";

const remote: RemoteConfig = {
  host: "dellserver",
  label: "Dell server",
  wtPath: "~/bin/wt",
};

function forwarded(argv: string[]): string[] {
  const encoded = argv.at(-1)?.match(/_remote ([A-Za-z0-9_-]+)$/)?.[1];
  if (!encoded) throw new Error("missing encoded remote argv");
  return decodeRemoteArgs(encoded);
}

describe("prepareRemoteAction", () => {
  test("runs a configured shell action without requiring a matching remote wt", () => {
    const def = {
      kind: "shell",
      id: "deploy",
      name: "Deploy",
      shell: "deploy --stage {{stage}}",
      affects: [],
      requires: [],
      argPrompt: null,
      labelExtract: null,
    } satisfies ActionDef;
    const result = prepareRemoteAction(
      def,
      remote,
      "/remote/task",
      "task",
      "",
      { stage: "task-stage" },
      "codex",
    );
    const command = result.argv.at(-1)!;
    expect(command).toContain("exec /bin/sh -c");
    expect(command).toContain("/remote/task");
    expect(command).toContain("deploy --stage task-stage");
    expect(command).not.toContain("_action-exec");
    expect(command).not.toContain("~/bin/wt");
  });

  test("runs a headless prompt directly on the remote host", () => {
    const def = {
      kind: "claude",
      id: "rebase-main",
      name: "Rebase on base",
      prompt: "Rebase origin/{{base}} and don't lose changes",
      target: "headless",
      affects: ["git"],
      requires: [],
      argPrompt: null,
      labelExtract: null,
    } satisfies ActionDef;
    const result = prepareRemoteAction(
      def,
      remote,
      "/remote/task",
      "task",
      "",
      { base: "staging" },
      "codex",
    );
    const command = result.argv.at(-1)!;
    expect(command).toContain("codex");
    expect(command).toContain("Rebase origin/staging");
    expect(command).not.toContain("_action-exec");
  });

  test("resolves the dev builtin through remote wt, not a local absolute path", () => {
    const def = {
      kind: "shell",
      id: "dev-server-start",
      name: "Start dev",
      shell: "'/local/bin/wt' dev start {{slug}}",
      affects: ["dev"],
      requires: [],
      argPrompt: null,
      labelExtract: null,
    } satisfies ActionDef;
    const result = prepareRemoteAction(
      def,
      remote,
      "/remote/task",
      "task",
      "",
      { slug: "task" },
      "codex",
    );
    expect(forwarded(result.argv)).toEqual(["dev", "start", "task"]);
  });
});
