import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { makeEdit } from "../text-edit.tsx";
import { Footer } from "./footer.tsx";

for (const prompt of ["new worktree:", "tracker id for a-very-long-existing-worktree-name (empty = no issue):"]) {
test(`footer input remains visible after resize: ${prompt}`, async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  const setup = await testRender(
    <QueryClientProvider client={client}>
      <box flexDirection="column" height="100%">
        <text flexGrow={1}>content above input</text>
        <Footer mode={{ kind: "input", purpose: "new", prompt, edit: makeEdit("long-task-name-日本語-👩‍💻-end") }} />
      </box>
    </QueryClientProvider>,
    { width: 100, height: 12 },
  );
  try {
    for (const width of [100, 35, 60, 80, 100]) {
      act(() => setup.resize(width, 12));
      await act(async () => { await setup.flush(); });
      await act(async () => { await setup.flush(); });
      const lines = setup.captureCharFrame().split("\n");
      const footer = lines.at(-2);
      expect(footer).toContain("-end█");
      expect(footer).not.toContain("[m]");
      expect(lines[0]).toContain("content above input");
    }
  } finally {
    act(() => setup.renderer.destroy());
    client.clear();
  }
});
}
