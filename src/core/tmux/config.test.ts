import { describe, expect, test } from "bun:test";

import { buildConfig } from "./config.ts";
import { sessionSwitchTarget } from "./naming.ts";

describe("worktree session shortcut routing", () => {
  test("the owning F-key detaches and cross-session keys request a switch", () => {
    const config = buildConfig();
    expect(config).toContain(
      "F10 if-shell -F '#{==:#{@wt-shortcut},shell}' 'detach-client'",
    );
    expect(config).toContain(
      "F11 if-shell -F '#{==:#{@wt-shortcut},diff}' 'detach-client'",
    );
    expect(config).toContain(
      "F12 if-shell -F '#{==:#{@wt-shortcut},harness}' 'detach-client'",
    );
  });

  test("modified keys are forwarded in CSI-u format", () => {
    const config = buildConfig();
    expect(config).toContain("set -s extended-keys always");
    expect(config).toContain("set -s extended-keys-format csi-u");
    expect(config).toContain(":extkeys");
  });

  test("OSC 8 hyperlink boundaries are forwarded to the outer terminal", () => {
    expect(buildConfig()).toContain(
      "xterm*:hyperlinks,tmux-256color:hyperlinks",
    );
  });

  test("mouse selections copy to the macOS clipboard on release", () => {
    const config = buildConfig();
    expect(config).toContain(
      "bind-key -T copy-mode MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel pbcopy",
    );
    expect(config).toContain(
      "bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel pbcopy",
    );
  });

  test("private tmux-client exit statuses decode to their targets", () => {
    expect(sessionSwitchTarget(110)).toBe("shell");
    expect(sessionSwitchTarget(111)).toBe("diff");
    expect(sessionSwitchTarget(112)).toBe("harness");
    expect(sessionSwitchTarget(0)).toBeNull();
    expect(sessionSwitchTarget(null)).toBeNull();
  });
});
