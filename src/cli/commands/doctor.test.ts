import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pnpmPhantomTopLevel } from "./doctor.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * Build a pnpm-shaped `node_modules`. `store` is what `.pnpm` holds;
 * `links` are correct top-level symlinks into it; `real` are directories
 * written at the top level by something that is not pnpm.
 */
function tree(opts: {
  linker?: string | null;
  store?: string[];
  links?: string[];
  real?: Array<[name: string, version: string]>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "wt-pnpm-"));
  dirs.push(root);
  const nm = join(root, "node_modules");
  mkdirSync(join(nm, ".pnpm"), { recursive: true });
  if (opts.linker !== null) {
    writeFileSync(
      join(nm, ".modules.yaml"),
      JSON.stringify({ nodeLinker: opts.linker ?? "isolated", virtualStoreDir: ".pnpm" }),
    );
  }
  for (const e of opts.store ?? []) mkdirSync(join(nm, ".pnpm", e), { recursive: true });
  for (const l of opts.links ?? []) {
    if (l.includes("/")) mkdirSync(join(nm, l.split("/")[0]!), { recursive: true });
    symlinkSync(join(nm, ".pnpm", "whatever"), join(nm, l));
  }
  for (const [name, version] of opts.real ?? []) {
    const d = join(nm, name);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "package.json"), JSON.stringify({ name, version }));
  }
  return nm;
}

describe("pnpmPhantomTopLevel", () => {
  test("a healthy isolated tree reports nothing", () => {
    // The false-positive that matters: this runs for every pnpm user,
    // and a warning on a correct tree is noise nobody can act on.
    const nm = tree({
      store: ["react@18.3.1", "@supabase+auth-js@2.85.0"],
      links: ["react", "@supabase/auth-js"],
    });
    expect(pnpmPhantomTopLevel(nm)).toEqual({ phantoms: [], drifted: [] });
  });

  test("a real directory whose version the store lacks is drift", () => {
    // The reported case, reduced: the store was bumped to 2.85 and the
    // top level still resolves 2.72, which is what the code imports.
    const nm = tree({
      store: ["@supabase+auth-js@2.85.0"],
      real: [["@supabase/auth-js", "2.72.0"]],
    });
    expect(pnpmPhantomTopLevel(nm)).toEqual({
      phantoms: ["@supabase/auth-js"],
      drifted: ["@supabase/auth-js 2.72.0 → 2.85.0"],
    });
  });

  test("a phantom still matching the store is counted but not drift", () => {
    // Latent, not active: it resolves correctly today and will freeze
    // silently at the next bump. Worth an info line, not a warning.
    const nm = tree({ store: ["lodash@4.17.21"], real: [["lodash", "4.17.21"]] });
    expect(pnpmPhantomTopLevel(nm)).toEqual({ phantoms: ["lodash"], drifted: [] });
  });

  test("a peer-suffixed store entry still matches its plain version", () => {
    // `.pnpm` writes `name@version_peerhash`; reading the suffix as part
    // of the version would report every peer-dependent package drifted.
    const nm = tree({
      store: ["react-dom@18.3.1_react@18.3.1"],
      real: [["react-dom", "18.3.1"]],
    });
    expect(pnpmPhantomTopLevel(nm)?.drifted).toEqual([]);
  });

  test("a hoisted linker is not this layout and gets no opinion", () => {
    // Real top-level directories are CORRECT there, so the whole
    // premise is absent — not merely unviolated.
    const nm = tree({ linker: "hoisted", real: [["lodash", "1.0.0"]] });
    expect(pnpmPhantomTopLevel(nm)).toBeNull();
  });

  test("an unreadable .modules.yaml means unknown, never fine", () => {
    const nm = tree({ linker: null, real: [["lodash", "1.0.0"]] });
    expect(pnpmPhantomTopLevel(nm)).toBeNull();
  });

  test("dot-entries and scope containers are not packages", () => {
    const nm = tree({ store: ["react@18.3.1"], links: ["react"] });
    mkdirSync(join(nm, ".cache"), { recursive: true });
    mkdirSync(join(nm, "@empty-scope"), { recursive: true });
    expect(pnpmPhantomTopLevel(nm)?.phantoms).toEqual([]);
  });
});
