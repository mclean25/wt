import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import type { PerfProc, PerfSnapshot } from "../../core/perf.ts";
import { PerfOverlay } from "./perf.tsx";

const proc: PerfProc = {
  pid: 1234, ppid: 1, cpu: 80, rssMb: 400, etime: "00:20:13",
  command: "bun test /tmp/fixture/very-long-file-name-and-important-final-test.ts",
  category: "test", session: "日本語テストセッション",
};
const snapshot: PerfSnapshot = {
  sampledAt: 0, cores: 8, loadAvg: [1, 2, 3],
  memTotalMb: 32000, memUsedMb: 12000,
  systemCpu: 250, wtCpu: 200, wtRssMb: 600, wtProcCount: 2,
  categories: [{ category: "test", cpu: 200, rssMb: 600, count: 2 }],
  sessions: [{ name: proc.session!, cpu: 200, rssMb: 600, count: 2, summary: "tests×2" }],
  top: [proc], outsiders: [{ ...proc, session: null }], orphans: [],
};

test("perf preserves numeric readings on narrow terminals and marks clipped commands inside the modal cap", async () => {
  const setup = await testRender(<PerfOverlay snapshot={snapshot} error={null} inject={{ kind: "idle" }} />, { width: 160, height: 60 });
  try {
    for (const width of [160, 40, 30, 160]) {
      act(() => setup.resize(width, 60));
      await setup.flush();
      const frame = setup.captureCharFrame();
      expect(frame).toContain("250% of 800% · 8 cores");
      expect(frame).toContain("200% · 600M rss");
      expect(frame).toContain("11.7G of 31.3G");
      if (width === 160) {
        const command = frame.split("\n").find((line) => line.includes("日本語") && line.includes("bun test"));
        expect(command).toMatch(/\.\.\. {2,}bun test/);
        expect(command).toMatch(/final\.\.\.\s*║/);
        expect(frame).toContain("日本語テスト... ");
      }
    }
  } finally {
    act(() => setup.renderer.destroy());
  }
});
