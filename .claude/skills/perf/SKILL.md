---
name: perf
description: Investigate and improve performance — "the machine feels slow", "wt/the TUI feels laggy", high CPU/memory, runaway processes, or proactive perf review of wt code. Runs the wt perf tooling, attributes load, diagnoses against known failure signatures, and proposes fixes. Keeps notes.md (same dir) current with baseline, open issues, and learnings.
---

# perf — investigate & improve performance

You are the perf debugger for this machine and this codebase. The
deliverable is an **assessment plus a proposed fix** — do not apply
code changes or kill processes without an explicit go-ahead, unless the
user's invocation already asked for a fix.

**Read `notes.md` (next to this file) FIRST.** It holds the current
baseline, open issues, and the learnings ledger — a symptom you're
about to investigate may already have a known signature there.

## 1. Pick the right instrument

Two different questions, two different tools:

| Symptom | Tool |
|---|---|
| "Machine feels slow — is wt/agents eating the box?" | `wt perf` (one-shot CLI; `--json` for raw structure). Same sampler as the TUI `P` overlay. |
| "The TUI itself is laggy (j/k, slow paint)" | Loop-lag probe: restart the TUI as `WT_PERF=1 wt`, reproduce, then grep the daily app log for `event-loop blocked`. It logs any >50ms block of the render thread (file-only, never the pane). |

The loop-lag probe arms only at startup — it can NOT be attached to a
running instance. If the symptom is TUI lag and the probe isn't armed,
say so and ask Michael to restart with `WT_PERF=1` (that restart is his
call; the TUI holds real state).

## 2. Capture

- Run `wt perf`. Its `%CPU` is `ps`'s **lifetime decaying average** —
  sustained pressure, not an instantaneous profile. A long-lived
  process showing 130% may be idle right now.
- When the average vs. now distinction matters, get a second opinion:
  `top -l 2 -n 12 -o cpu -stats pid,cpu,mem,command | tail -20`
  (the second sample of `top -l 2` is a true instantaneous delta), or
  re-run `wt perf` ~60s later and compare direction.
- Memory "used" in the report is vm_stat active+wired+compressor
  (Activity Monitor's definition). Never reason from `os.freemem()` —
  it reads ~90% used on any long-uptime Mac.
- For wt-internal state behind a symptom (stuck rows, stale queries,
  session sprawl), use the `wt-state` skill's read-only scripts.
- Daily app log: `~/.cache/wt/logs/app/wt-YYYY-MM-DD.log`
  (`grep ' EVENT '` for the activity feed, `grep 'event-loop blocked'`
  for probe hits).

## 3. Attribute honestly

The report is framed as **wt-downstream vs the rest of the machine**,
and the "Heaviest processes NOT downstream of wt" block is the point:
when the hog is a browser or another app, say so plainly and stop —
don't hunt for a wt/agent explanation to justify the invocation.
Compare wt's share against CPU *in use*, not installed capacity.

## 4. Diagnose

Check the known signatures in `notes.md` first (orphaned headless
instances, Bun bare-promise spin, worker-less parsing on the render
thread, ...). For new wt-side suspects:

- Walk the tree: `ps -o pid,ppid,pcpu,rss,etime,command -p <pid>` and
  children; `wt perf --json` has ppid-free but session-attributed data.
- Correlate with the app log timeline (what was wt doing when load
  rose?).
- For render-thread suspects, reason from the armed loop-lag probe's
  timestamps, not vibes.
- For code-level work (reviewing a diff for perf, optimizing a module),
  the repo rules still apply: batched GitHub fetches, push-based
  freshness, workers for heavy parsing — see the learnings ledger.

## 5. Propose

Report: what the load is, whose it is, whether it's reasonable, and if
not, the specific fix (code change, kill line, config change) — with
the evidence. Wait for the go-ahead before mutating anything. A
ready-to-run `kill` line for leaked instances is a proposal, not an
action.

## 6. Update notes.md — every invocation

`notes.md` is a living document; keeping it current is part of the
skill, not optional:

- Refresh the **Baseline** section when you capture a snapshot that's
  representative (or when hardware/workload shifts make the old one
  stale). Keep it a summary, not a paste of the full report.
- Add/resolve entries in **Open issues** as they're found/fixed
  (resolved ones move to the ledger with the fixing commit).
- Append to the **Learnings ledger** whenever an investigation produces
  a reusable signature, technique, or trap — the test is "would the
  next investigation go faster knowing this".
- Prune: stale baselines and superseded learnings get rewritten, not
  accumulated.

Commit `notes.md` changes (this repo commits directly to main; ride
along with the investigation's other changes or commit standalone).
