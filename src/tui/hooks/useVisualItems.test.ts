import { describe, expect, test } from "bun:test";

import type { RemoteWorktreeSummary } from "../../core/remote-worktrees.ts";
import type { WorktreeRow } from "./useWorktreeRows.ts";
import { GROUP_INBOX } from "./useWorktreeRows.ts";
import { buildActiveItems } from "./useVisualItems.ts";

function local(slug: string, section: string | null): WorktreeRow {
  return {
    archived: false,
    section,
    wt: { slug, branch: `alex/${slug}`, path: `/local/${slug}`, stage: slug },
  } as WorktreeRow;
}

function remote(slug: string, section: string | null): RemoteWorktreeSummary {
  return {
    remote: { host: "dellserver", label: "Dell server", wtPath: "wt" },
    hostKey: "dellserver",
    hostLabel: "Dell server",
    slug,
    branch: `alex/${slug}`,
    base: "main",
    path: `/remote/${slug}`,
    stage: slug,
    section,
    exists: true,
    status: "clean",
    statusLabel: "clean",
    statusAge: null,
    statusOp: null,
    dirty: false,
    unpushed: 0,
    pushed: true,
    aheadOfBase: 0,
    issueUrl: null,
    issueId: null,
    workState: null,
    workNote: null,
    workRisk: null,
    workBlockedOn: null,
    workVerifyAfterMerge: null,
    workAt: null,
  };
}

describe("buildActiveItems", () => {
  test("places remote rows beside local rows in their normal section", () => {
    const items = buildActiveItems({
      rows: [local("local-paused", "Paused"), local("local-inbox", null)],
      foldedSections: new Set(),
      remoteCreation: null,
      remoteWorktrees: [remote("remote-paused", "Paused"), remote("remote-inbox", null)],
      archivedKeys: new Set(),
    });

    expect(items.map((item) =>
      item.kind === "wt"
        ? `local:${item.row.wt.slug}`
        : item.kind === "remote"
          ? `remote:${"slug" in item.entry ? item.entry.slug : item.entry.input}`
          : `section:${item.sectionKey}`,
    )).toEqual([
      "local:local-paused",
      "remote:remote-paused",
      "local:local-inbox",
      "remote:remote-inbox",
    ]);
  });

  test("folds local and remote members into one shared section header", () => {
    const [item] = buildActiveItems({
      rows: [local("local", "Paused")],
      foldedSections: new Set(["Paused"]),
      remoteCreation: null,
      remoteWorktrees: [remote("remote", "Paused")],
      archivedKeys: new Set(),
    });

    expect(item?.kind).toBe("section");
    if (item?.kind !== "section") throw new Error("expected folded section");
    expect(item.sectionKey).toBe("Paused");
    expect(item.members.map((member) => member.kind)).toEqual(["wt", "remote"]);
  });

  test("files transient remote creation into Inbox", () => {
    const [item] = buildActiveItems({
      rows: [],
      foldedSections: new Set([GROUP_INBOX]),
      remoteCreation: {
        remote: { host: "dellserver", label: "Dell server", wtPath: "wt" },
        hostKey: "dellserver",
        hostLabel: "Dell server",
        input: "new-task",
        status: "creating",
      },
      remoteWorktrees: [],
      archivedKeys: new Set(),
    });

    expect(item).toMatchObject({ kind: "section", sectionKey: GROUP_INBOX });
  });
});
