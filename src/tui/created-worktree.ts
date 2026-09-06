/** Initial placement expires when the row's status or manual layout changes. */
export type CreatedWorktreePlacement = {
  key: string;
  ledgerKey: string;
  section: string | null;
  workAt: string | undefined;
  order: number;
};
