import { describe, expect, test } from "bun:test";

import type { RemoteWorktreeSummary } from "../../core/remote-worktrees.ts";
import type { WorktreeRow } from "./useWorktreeRows.ts";
import { GROUP_INBOX } from "./useWorktreeRows.ts";
import { buildActiveItems, visibleReviewRequests, visualKey } from "./useVisualItems.ts";
import type { ReviewRequestPr } from "../../core/github.ts";
import { DEV_SERVER_STOPPED } from "../../core/dev-server.ts";

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
    deployed: false,
    section,
    exists: true,
    status: { kind: "clean", label: "clean" },
    dev: DEV_SERVER_STOPPED,
    dirty: false,
    unpushed: 0,
    pushed: true,
    aheadOfBase: 0,
    issueUrl: null,
    issueId: null,
    githubIssue: null,
    githubIssueUrl: null,
    work: null,
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

  test("immediately reveals a selectable placeholder even when Inbox is folded", () => {
    const [item] = buildActiveItems({
      rows: [],
      foldedSections: new Set([GROUP_INBOX]),
      remoteCreation: {
        remote: { host: "dellserver", label: "Dell server", wtPath: "wt" },
        hostKey: "dellserver",
        hostLabel: "Dell server",
        input: "new-task",
        previousKeys: [],
        status: "creating",
      },
      remoteWorktrees: [],
      archivedKeys: new Set(),
    });

    expect(item).toMatchObject({
      kind: "remote", entry: { input: "new-task", status: "creating" },
      target: null, model: null,
    });
    expect(visualKey(item!)).toBe("remote:creating:dellserver:new-task");
  });

  test("holds a differently-slugged inventory row until creation completes", () => {
    const items = buildActiveItems({
      rows: [],
      foldedSections: new Set(),
      remoteCreation: {
        remote: { host: "dellserver", label: "Dell server", wtPath: "wt" },
        hostKey: "dellserver",
        hostLabel: "Dell server",
        input: "COZ-123",
        previousKeys: ["dellserver:existing"],
        status: "creating",
      },
      remoteWorktrees: [remote("existing", null), remote("coz-123-calm-otter", null)],
      archivedKeys: new Set(),
    });

    expect(items.map((item) =>
      item.kind === "remote" && "slug" in item.entry
        ? item.entry.slug
        : "placeholder",
    )).toEqual(["existing", "placeholder"]);
  });

  test("appends the pending row after existing inbox members", () => {
    const items = buildActiveItems({
      rows: [],
      foldedSections: new Set(),
      remoteCreation: {
        remote: { host: "dellserver", label: "Dell server", wtPath: "wt" },
        hostKey: "dellserver",
        hostLabel: "Dell server",
        input: "COZ-123",
        previousKeys: ["dellserver:existing"],
        status: "creating",
      },
      remoteWorktrees: [remote("existing", null)],
      archivedKeys: new Set(),
    });

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "remote", entry: { slug: "existing" } });
  });
});

describe("visibleReviewRequests", () => {
  test("hides only the dismissed PR snapshot", () => {
    const request = {
      url: "https://github.com/example/repo/pull/12",
      updatedAt: "2026-09-09T10:00:00Z",
    } as ReviewRequestPr;
    const dismissals = [{
      url: request.url,
      updatedAt: request.updatedAt,
      dismissedAt: "2026-09-09T10:01:00Z",
    }];

    expect(visibleReviewRequests([request], dismissals)).toEqual([]);
    expect(visibleReviewRequests(
      [{ ...request, updatedAt: "2026-09-09T11:00:00Z" }],
      dismissals,
    )).toHaveLength(1);
  });
});

test("completed creation exposes a real selectable session target", () => {
  const [item] = buildActiveItems({
    rows: [], foldedSections: new Set(), remoteCreation: null,
    remoteWorktrees: [remote("coz-123-calm-otter", null)], archivedKeys: new Set(),
  });
  expect(item?.kind).toBe("remote");
  if (item?.kind !== "remote") throw new Error("expected remote row");
  expect(item.model?.source.kind).toBe("remote");
  expect(item.model?.slug).toBe("coz-123-calm-otter");
  expect(item.target).not.toBeNull();
});

test("creation does not hide inventory from another host", () => {
  const other = { ...remote("elsewhere", null), hostKey: "other-host" };
  const items = buildActiveItems({
    rows: [], foldedSections: new Set(), archivedKeys: new Set(),
    remoteCreation: {
      remote: { host: "dellserver", label: "Dell server", wtPath: "wt" },
      hostKey: "dellserver", hostLabel: "Dell server", input: "new-task",
      previousKeys: [], status: "creating",
    },
    remoteWorktrees: [remote("new-task", null), other],
  });
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ kind: "remote", entry: { hostKey: "other-host" } });
});

test("new local worktree appends after remote and local peers in its section", () => {
  const fresh = local("fresh", "Batch");
  const items = buildActiveItems({
    rows: [fresh, local("older", "Batch"), local("elsewhere", null)],
    remoteWorktrees: [remote("remote-peer", "Batch")],
    remoteCreation: null, foldedSections: new Set(), archivedKeys: new Set(),
    createdPlacements: [{ key: "fresh", ledgerKey: "fresh", section: "Batch", workAt: undefined, order: 5 }],
  });
  expect(items.map((item) => item.kind === "section" ? item.sectionKey : item.model?.slug))
    .toEqual(["older", "remote-peer", "fresh", "elsewhere"]);
});

test("new remote worktrees append in creation order, independent of inventory order", () => {
  const items = buildActiveItems({
    rows: [local("older", null)],
    remoteWorktrees: [remote("second", null), remote("first", null)],
    remoteCreation: null, foldedSections: new Set(), archivedKeys: new Set(),
    createdPlacements: ["first", "second"].map((slug) => ({
      key: `remote:dellserver:${slug}`, ledgerKey: `@remote/dellserver/${slug}`,
      section: null, workAt: undefined, order: 5,
    })),
  });
  expect(items.map((item) => item.kind === "section" ? item.sectionKey : item.model?.slug))
    .toEqual(["older", "first", "second"]);
});

test("a new status claim releases the initial bottom placement", () => {
  const fresh = { ...local("fresh", null), work: { state: "working", at: "later" } } as WorktreeRow;
  const items = buildActiveItems({
    rows: [fresh, local("older", null)], remoteWorktrees: [], remoteCreation: null,
    foldedSections: new Set(), archivedKeys: new Set(),
    createdPlacements: [{ key: "fresh", ledgerKey: "fresh", section: null, workAt: undefined, order: 5 }],
  });
  expect(items[0]).toMatchObject({ kind: "wt", row: { wt: { slug: "fresh" } } });
});

test("pending identity cannot collide with an existing same-name worktree", () => {
  const existing = remote("new-task", null);
  const items = buildActiveItems({
    rows: [], foldedSections: new Set(), archivedKeys: new Set(),
    remoteCreation: {
      remote: existing.remote, hostKey: existing.hostKey, hostLabel: existing.hostLabel,
      input: "new-task", previousKeys: ["dellserver:new-task"], status: "creating",
    },
    remoteWorktrees: [existing],
  });
  expect(new Set(items.map(visualKey)).size).toBe(2);
  expect(items[1]).toMatchObject({ entry: { input: "new-task" }, target: null });
});
