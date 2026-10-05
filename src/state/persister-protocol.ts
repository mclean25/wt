export type CacheRequest = {
  type: "get" | "set" | "remove" | "entries" | "clear" | "close";
  id: number;
  dbPath: string;
  key?: string;
  value?: string;
};

export type CacheValue = string | null | void | Array<[string, string]>;

export type CacheResult =
  | { type: "result"; id: number; value: CacheValue }
  | { type: "error"; id: number; operation: string; message: string };
