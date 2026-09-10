/** Authoritative definitions for wt-owned harness targets that are not worktrees. */
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "./config.ts";
import { MANAGER_CLAUDE_NAME, MANAGER_SLUG } from "./manager.ts";
import { WT_SOURCE_SLUG } from "./tmux/naming.ts";

const WT_REPO_PATH = resolve(import.meta.dir, "..", "..");

export type SessionSlot = {
  slug: string;
  path: string;
  label: string;
  key: string;
  paletteKey: string;
  /** Native Claude name used to keep same-cwd slots distinct. */
  claudeName: string | null;
};

export const WT_SOURCE_SLOT: SessionSlot = {
  slug: WT_SOURCE_SLUG,
  path: WT_REPO_PATH,
  label: "wt",
  key: ",",
  paletteKey: "<",
  claudeName: null,
};

export const MAIN_CLONE_SLOT: SessionSlot = {
  slug: "main",
  path: config.paths.mainClone,
  label: "main",
  key: ".",
  paletteKey: ">",
  claudeName: null,
};

export const DOTFILES_SLOT: SessionSlot = {
  slug: "dotfiles",
  path: config.paths.dotfiles,
  label: "dotfiles",
  key: "/",
  paletteKey: "\\",
  claudeName: null,
};

export const MANAGER_SLOT: SessionSlot = {
  slug: MANAGER_SLUG,
  path: config.paths.mainClone,
  label: "manager",
  key: "m",
  paletteKey: "M",
  claudeName: MANAGER_CLAUDE_NAME,
};

export const SESSION_SLOTS: readonly SessionSlot[] = [
  WT_SOURCE_SLOT,
  MAIN_CLONE_SLOT,
  DOTFILES_SLOT,
  MANAGER_SLOT,
];

export const SLOT_SLUGS: readonly string[] = SESSION_SLOTS.map((slot) => slot.slug);
export const dotfilesSlotAvailable = existsSync(DOTFILES_SLOT.path);
export const OFFERED_SLOTS: readonly SessionSlot[] = SESSION_SLOTS.filter(
  (slot) => slot.slug !== DOTFILES_SLOT.slug || dotfilesSlotAvailable,
);

export function sessionSlot(slug: string): SessionSlot | null {
  return SESSION_SLOTS.find((slot) => slot.slug === slug) ?? null;
}
