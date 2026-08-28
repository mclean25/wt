/**
 * Fleet identity is deliberately separate from checkout access. A worktree's
 * slug names it on one host; its location decides whether filesystem / git
 * operations run locally or over SSH. Local ledgers use this key so remote
 * worktrees can participate without pretending their checkout is local.
 *
 * Local keys remain bare slugs for compatibility with the former archive.json
 * format. Remote keys live in a reserved, encoded namespace.
 */
export type WorktreeRef =
  | { kind: "local"; slug: string }
  | { kind: "remote"; host: string; slug: string };

const REMOTE_LEDGER_PREFIX = "@remote/";

export function worktreeLedgerKey(ref: WorktreeRef): string {
  if (ref.kind === "local") return ref.slug;
  return `${REMOTE_LEDGER_PREFIX}${encodeURIComponent(ref.host)}/${encodeURIComponent(ref.slug)}`;
}

export function remoteWorktreeLedgerKey(host: string, slug: string): string {
  return worktreeLedgerKey({ kind: "remote", host, slug });
}

export function remoteWorktreeLedgerPrefix(host: string): string {
  return `${REMOTE_LEDGER_PREFIX}${encodeURIComponent(host)}/`;
}

export function isRemoteWorktreeLedgerKey(key: string): boolean {
  return key.startsWith(REMOTE_LEDGER_PREFIX);
}
