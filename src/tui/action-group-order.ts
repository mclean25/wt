/** Reorder groups without changing items or their already-assigned shortcuts. */
export function actionGroupsLast<T>(groups: ReadonlyMap<string, readonly T[]>, last: readonly string[], trailingItems: readonly T[] = []): T[] {
  const trailing = new Set(last);
  return [
    ...[...groups].filter(([name]) => !trailing.has(name)).flatMap(([, items]) => items),
    ...trailingItems,
    ...[...trailing].flatMap((name) => groups.get(name) ?? []),
  ];
}
