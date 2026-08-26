import { describe, expect, test } from "bun:test";

import { plistProgramOf } from "./events.ts";

/**
 * The plist bakes an interpreter path, and on Homebrew that path is
 * version-specific: `brew upgrade bun` deletes it and launchd can no longer
 * exec the job. A daemon already running survives, so the agent reads healthy
 * right up until somebody restarts it — at which point `launchctl list` shows
 * a bare exit 78 and BOTH daemon logs stay empty, because nothing ran to write
 * to them. This parse is the only thing that can name the cause.
 */
describe("plistProgramOf", () => {
  const wrap = (args: string[]) =>
    `<plist version="1.0">\n<dict>\n  <key>ProgramArguments</key>\n  <array>\n` +
    args.map((a) => `    <string>${a}</string>`).join("\n") +
    `\n  </array>\n  <key>KeepAlive</key>\n  <true/>\n</dict>\n</plist>\n`;

  test("takes the first argv entry, not a later one", () => {
    expect(plistProgramOf(wrap(["/Users/me/.wt/bin/wt", "events", "serve"]))).toBe(
      "/Users/me/.wt/bin/wt",
    );
  });

  test("reads the pre-2026-08 shape, whose program is the interpreter", () => {
    // The population this diagnostic exists for: every agent installed
    // before the launcher switch still has a Cellar path baked in.
    expect(
      plistProgramOf(wrap(["/opt/homebrew/Cellar/bun/1.3.14/bin/bun", "/Users/me/.wt/src/main.ts", "events", "serve"])),
    ).toBe("/opt/homebrew/Cellar/bun/1.3.14/bin/bun");
  });

  test("does not pick up a <string> from a different key", () => {
    // EnvironmentVariables sits right next to ProgramArguments and is all
    // strings; matching loosely would name PATH as the program.
    const xml =
      `<dict>\n  <key>Label</key>\n  <string>com.wt.events</string>\n` +
      `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key>\n    <string>/usr/bin</string>\n  </dict>\n` +
      wrap(["/Users/me/.wt/bin/wt", "events", "serve"]);
    expect(plistProgramOf(xml)).toBe("/Users/me/.wt/bin/wt");
  });

  test("an unrecognised document answers null rather than guessing", () => {
    expect(plistProgramOf("<plist><dict></dict></plist>")).toBeNull();
    expect(plistProgramOf("")).toBeNull();
  });
});
