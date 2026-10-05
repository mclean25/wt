import { Effect } from "effect";

import { operationErrors } from "../../core/errors.ts";
import { forkReported } from "../effect-boundary.ts";
import type { WorktreeRow } from "../hooks/useWorktreeRows.ts";
import type { FooterMode } from "../panels/footer.tsx";
import { makeEdit } from "../text-edit.tsx";
import { theme } from "../theme.ts";

const io = operationErrors("worktree title flow");
type TitleInput = Extract<FooterMode, { kind: "input" }>;

export type WorktreeTitleFlowCtx = {
  current: WorktreeRow | undefined;
  setFooter: (footer: FooterMode | ((previous: FooterMode) => FooterMode)) => void;
  setManualTitle: (slug: string, title: string) => Promise<void>;
  isSlugLive: (slug: string) => boolean;
  toast: (message: string, color?: string, ms?: number) => void;
};

export function makeWorktreeTitleFlows(ctx: WorktreeTitleFlowCtx) {
  function openWorktreeTitlePrompt(): void {
    if (!ctx.current) return;
    ctx.setFooter({
      kind: "input",
      prompt: `title for ${ctx.current.wt.slug}:`,
      edit: makeEdit(ctx.current.title),
      purpose: "worktree-title",
      titleSlug: ctx.current.wt.slug,
    });
  }

  function commitWorktreeTitle(submitted: TitleInput): void {
    const title = submitted.edit.value.trim();
    if (!title) {
      ctx.toast("enter a title; Esc cancels", theme.warn, 2000);
      return;
    }
    const slug = submitted.titleSlug;
    if (!slug || !ctx.isSlugLive(slug)) {
      ctx.setFooter({ kind: "legend" });
      ctx.toast(`${slug ?? "worktree"} is gone; title not written`, theme.warn, 2500);
      return;
    }
    ctx.setFooter({ kind: "legend" });
    // Saving the unchanged prefill is intentional: it makes today's resolved
    // title a durable manual choice, including when it came from AI.
    forkReported(
      io.promise("set worktree title", () => ctx.setManualTitle(slug, title)).pipe(
        Effect.tap(() => Effect.sync(() =>
          ctx.toast("title saved; automatic naming disabled", theme.info, 2500),
        )),
      ),
      (error) => {
        ctx.setFooter((previous) =>
          previous.kind === "legend" ? submitted : previous,
        );
        ctx.toast(`set title failed: ${error.message}`, theme.err, 3000);
      },
    );
  }

  return { openWorktreeTitlePrompt, commitWorktreeTitle };
}
