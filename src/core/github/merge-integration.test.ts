import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = mkdtempSync(join(tmpdir(), "wt-merge-api-"));
const cfg = join(root, "config.toml");
const calls = join(root, "calls.jsonl");
const repo = resolve(import.meta.dir, "../../..");
afterAll(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(cfg, `[paths]\nmain_clone=${JSON.stringify(root)}\nworktree_root=${JSON.stringify(join(root, "wts"))}\ncache_db=${JSON.stringify(join(root, "cache.sqlite"))}\nstate_db=${JSON.stringify(join(root, "state.sqlite"))}\n[branch]\nprefix="test"\nbase="main"\n`);
writeFileSync(join(root, "gh"), `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.MERGE_CALLS, JSON.stringify(args)+"\\n");
if (args[0] === "repo") console.log(JSON.stringify({nameWithOwner:"test/repo"}));
else if(args.includes("graphql")) {
 const query = args.find(x=>x.startsWith("query=")) || "";
 if(query.includes("mergeQueue(branch:")) console.log(JSON.stringify({data:{repository:{mergeQueue:process.env.MERGE_CASE === "classic" ? null : {id:"MQ"}}}}));
 else if(query.includes("enablePullRequestAutoMerge")) console.log(JSON.stringify({data:{enablePullRequestAutoMerge:{pullRequest:{number:12}}}}));
 else process.exit(9);
} else {
 if(process.env.MERGE_CASE === "ambiguous") { console.error("connection lost; required status check is expected"); process.exit(1); }
 if(args.includes("--include") || args.includes("-i")) console.log("HTTP/2 "+(process.env.MERGE_CASE === "failed" ? "400" : "200")+"\\r\\ncontent-type: application/json\\r\\n\\r\\n");
 console.log(JSON.stringify(process.env.MERGE_CASE === "failed" ? {status:"failed",details:{message:'Required status check "CI" is expected.'}} : {status:"enqueued",details:{message:"Enqueued"}}));
 if(process.env.MERGE_CASE === "failed") process.exit(1);
}
`);
chmodSync(join(root, "gh"), 0o755);

function invoke(scenario: string, concurrent = false) {
  writeFileSync(calls, "");
  const call = 'enableAutoMerge("PR",{prNumber:12,baseRefName:"main",headRefOid:"abc123"})';
  const expression = concurrent
    ? `Effect.all([${call}, ${call}, disableAutoMerge(12,{prId:"PR"})], {concurrency:"unbounded"})`
    : call;
  const child = Bun.spawnSync(["bun", "-e", `import {Effect} from "effect"; import {enableAutoMerge,disableAutoMerge,mergeRequestInFlight} from "./src/core/github/mutations.ts"; const result = await Effect.runPromise(${expression}); if(mergeRequestInFlight(12)) throw new Error("in-flight marker leaked"); console.log(JSON.stringify(result));`], {
    cwd: repo,
    env: { ...process.env, WT_CONFIG: cfg, WT_REPO_CONFIG: "", PATH: `${root}:${process.env.PATH}`, MERGE_CASE: scenario, MERGE_CALLS: calls },
    stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return { result: JSON.parse(child.stdout.toString()), calls: readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]) };
}

test("shared app/CLI mutation submits queue-only REST and never classic on success", () => {
  const r = invoke("queue");
  expect(r.result.ok).toBe(true);
  expect(r.calls.some(a => a.includes("repos/test/repo/pulls/12/merge-async"))).toBe(true);
  expect(r.calls.flat().join(" ")).not.toContain("enablePullRequestAutoMerge");
});

test("non-queue bases retain classic arming without an async direct merge", () => {
  const r = invoke("classic");
  expect(r.result.ok).toBe(true);
  expect(r.calls.flat().join(" ")).toContain("enablePullRequestAutoMerge");
  expect(r.calls.flat().join(" ")).not.toContain("merge-async");
});

test("ambiguous queue submission never falls through even if stderr names pending checks", () => {
  const r = invoke("ambiguous");
  expect(r.result.ok).toBe(false);
  expect(r.result.retryable).not.toBe(true);
  expect(r.calls.flat().join(" ")).not.toContain("enablePullRequestAutoMerge");
});

test("definitive pending-check refusal can still arm classic auto-merge", () => {
  const r = invoke("failed");
  expect(r.result.ok).toBe(true);
  expect(r.calls.flat().join(" ")).toContain("enablePullRequestAutoMerge");
});

test("in-flight enable blocks duplicate submission and cancellation until resolved", () => {
  const r = invoke("queue", true);
  expect(r.result[0].ok).toBe(true);
  expect(r.result[1].error).toContain("still processing");
  expect(r.result[2].error).toContain("before cancelling");
  expect(r.calls.filter(a => a.includes("PUT"))).toHaveLength(1);
});
