# CLI reference

`wt` with no arguments launches the TUI (when stdout is a TTY; piped output falls back to `wt ls`). Everything below is the one-shot subcommand surface. `wt <cmd> --help` prints per-command usage.

Environment variables: `WT_CONFIG` points at an explicit config file; `XDG_CONFIG_HOME` relocates the default lookup (see [configuration.md](configuration.md)). Both are forwarded into the `wt events` launchd daemon so it loads the same config.

### `wt remote [<command> ...]`

With no arguments, allocate an SSH terminal and enter the `[remote]` host's
interactive `wt`. With arguments, forward the exact argv through a shell-safe
encoded transport to that installation—for example `wt remote ls --json` or
`wt remote new eng-123 --no-install`. Requires the optional `[remote]` config
and an independently configured `wt` on that host.

## Worktree lifecycle

### `wt ls`

List all non-main worktrees (slug, stage when `[deploy.sst]` is configured, PR, status). Worktrees destroyed in the last 48h stay visible — a dim `recently merged:` footer under the table, and an empty list says why it's empty (`No active worktrees (2 archived today: x, y).`) — so "everything landed" never reads identically to "nothing exists". Derived from the existing removed-worktrees history; the TUI's `h` view keeps the full 14-day record.

- `--json` — machine-readable array (slug, branch, path, stage, section, base, status, dirty, issue_id, issue_url, work_state, …). `section` is the manual TUI section the human placed the row in (`null` = inbox; inferred stack groupings never appear here — they're derived, not stored). `base` is the effective merge target (recorded fork base for stacked worktrees, else `[branch] base`) — never null. Recently-removed rows are appended with `kind: "merged"` (PR landed) or `"removed"`, plus `pr`, `pr_url`, `title`, and `archived_at`; live rows never carry a `kind` field, so consumers discriminate on it (the remote section's parser skips these rows).
- Push fields: `unpushed` counts commits `origin/<branch>` doesn't have — true unpushed work, not divergence from the base (wt sets the branch upstream to its BASE, so an upstream-relative count would misread as "never pushed"). `pushed` says whether `origin/<branch>` exists at all; when it's `false`, `unpushed` falls back to the ahead-of-base count. `ahead_of_base` is commits ahead of the upstream/base — the restack-pressure signal. All three are `null` when git couldn't answer; never read `null` as 0.

### `wt new <id [title…]|url|branch|slug>`

Create a worktree from an issue id (optionally followed by pasted title words), a tracker URL, an existing branch name, or a bare slug. Runs the full setup: fetch, checkout (`git worktree add`, or a `rift` clone — see [backends.md](backends.md)), env-file and configured-glob copy, SST stage pin (only with `[deploy.sst]` configured), package install (detected from the lockfile, or `[lifecycle] install_command`).

Issue-id input resolves like this:

- `wt new ENG-1953 fix calendar rendering` — id + title words mints `yourname/eng-1953-fix-calendar-rendering`.
- `wt new ENG-1953` — bare id mints a fresh branch with a random readable suffix (`yourname/eng-1953-cozy-elephant`), so repeat entries just create more worktrees for the same task — that's the intended way to get a second one.
- `wt new --attach ENG-1953` — attach to that id's *existing* branch instead: one match checks out, several offer a picker (interactive shells only — scripted calls error and must pass the branch explicitly), none is an error.
- Multiword input without a leading id (`wt new fix the calendar`) slugifies wholesale to `yourname/fix-the-calendar` — issue-less worktrees are first-class.
- With `[issue_tracker] prefix` set (e.g. `"eng"`), a differently-prefixed id (`wt new GH-970 …`) is rejected with guidance: a GitHub issue attaches as the secondary id via `--gh`, never as the worktree's identity.

- `--slug <s>` — explicit slug when creating from an issue id (equivalent to inline title words; wins when both are given).
- `--gh <n>` — attach GitHub issue `#n` as the worktree's secondary id (see `wt issue`).
- `--attach` — attach to an existing branch for the id instead of minting a new one.
- `--base <ref>` — fork base to branch from (recorded; see `wt base`).
- `--any` — with `--attach`, match branches by any author, not just your `branch.prefix`.
- `--open` / `--no-open` — open in Zed after creation (default: open when interactive).
- `--no-install` — skip the package-install step. Ignored under the `rift` backend, which copies packages via its clone.

If the branch already has a worktree, prints its path instead of erroring. A dirty main clone never blocks creation: the `rift` backend's CoW clone copies the main clone's uncommitted changes, and the post-clone branch switch discards them in the copy (`--discard-changes` — the main clone itself is never touched). Any create failure surfaces its reason on the CLI and the TUI attention feed instead of a row silently vanishing.

Creation also sets `branch.<name>.gh-merge-base` to the branch's real merge target (its fork base; the trunk for plain worktrees, the parent for stacked ones). `gh pr create` consults that config **before** the repository's default branch, so a bare `gh pr create` opens against the right base even in repos whose GitHub default branch isn't the integration branch — without it, agents were opening PRs against the default (the harness's own context hints them there), burning CI and review passes on a 100-file diff of other people's code. `wt doctor` checks the config against the recorded base to catch worktrees created before this or left stale by a reparent.

### `wt rm [<slug>]`

Remove a worktree (with dirty/unpushed guards, optional SST stage destroy, optional branch delete). No slug ⇒ interactive picker. The unpushed guard is suppressed for a merged/gone branch — a squash-merged worktree keeps its pre-squash commits locally but the work is landed, so it removes without a spurious `--force`.

- `--yes` / `-y` — skip confirmations.
- `--force` — remove despite uncommitted / unpushed work.
- `--destroy-stage` / `--no-destroy-stage` — force the SST stage decision (default: prompt when your stage looks deployed).
- `--delete-branch` / `--keep-branch` — default deletes the branch.
- `--background` / `-b` — dispatch as a background job (watch with `wt logs <slug>`).

Removal also closes the browser tabs the worktree's agents opened, by deleting its `browser-control` session (`wt-<slug>`, the `BROWSER_CONTROL_SESSION` every harness session inherits — see [fleet.md](fleet.md#the-design-responses)). Best-effort and silent: no `browser-control`, no relay running, or no browsing done means nothing happens. Tabs the human attached by hand are released, never closed.

And it reaps hand-started servers: any process holding a **listening TCP socket** whose cwd is inside the worktree (an agent's backgrounded `pnpm preview`, a stray vite) is SIGTERM'd — SIGKILL'd if it lingers — before the checkout is removed, with a `reaped …` line in the destroy log per kill. The listening-socket filter is the safety boundary: an editor or shell sitting in the directory holds no socket and is never touched. This is the cleanup half of the process contract — the managed half (`wt dev`) covers the one process meant to *outlive* an agent's session; everything else may run unmanaged precisely because destroy guarantees it can't outlive the worktree. Best-effort and silent when nothing is listening, which is the common case.

### `wt clean`

Remove every worktree that is merged or whose remote branch is gone. "Gone" is only auto-cleaned when a merged PR confirms the content actually landed; anything riskier is left for an explicit `wt rm`.

- `--yes` / `-y` — skip confirmation (required non-interactively).
- `--destroy-stage` / `--no-destroy-stage` — apply to all candidates (default: per-worktree, destroy iff its stage is live).
- `--foreground` — run removals synchronously (background dispatch is the default here, unlike `rm`).

### `wt doctor [<slug>]`

Health report: working tree, sync vs trunk, SST stage pin + deploy state, node_modules, locks, `gh-merge-base` branch config (must match the recorded fork base / trunk, or a bare `gh pr create` targets the repo default branch — see `wt new`), merged status, PR/CI. One worktree (or the one containing cwd), or all. Also banners machine-level issues: a main clone off its trunk branch, and pending agent-skill updates (`wt skills`).

- `--all` / `-a` — force the full summary table.
- `--json` — machine-readable.

### `wt open [<slug-or-query>]`

Open a worktree in Zed. Exact slug or case-insensitive substring; no query ⇒ interactive picker.

## Inspection & maintenance

### `wt stages`

List SST stages in the configured state bucket and flag orphans (no matching live worktree). Requires `[deploy.sst]`.

- `--clean` — destroy orphaned stages (`sst remove` per stage, in the main clone).
- `--yes` / `-y` — skip the destroy confirmation.
- `--json` — machine-readable `{live, orphaned}`.

### `wt dev <start|stop|status|logs> [<slug>]`

Manage the worktree's `[dev_server]` (see [configuration.md](configuration.md#dev_server--optional-per-worktree-dev-server)). `start` is also restart; `stop` keeps the slug's port reserved; `logs` prints the supervisor pane's recent output. The slug defaults to the worktree containing the current directory.

### `wt logs [<slug>]`

Tail a destroy log (`tail -F`). No slug ⇒ the most recently modified log.

### `wt perf [--json]`

One-shot perf snapshot framed as **wt-downstream vs the rest of the machine** — the headless form of the TUI's [`P` overlay](tui.md#perf-overlay-p): verdict numbers, per-category and per-worktree-session breakdowns, the heaviest processes on both sides, and any leaked headless wt instances. The default output is the same plain-text report the overlay's `i` key injects, written for handing to an agent ("is this load reasonable, and if not, whose is it?"); `--json` emits the raw `PerfSnapshot` instead. Same accuracy caveats as the overlay: `%CPU` is `ps`'s lifetime decaying average, not a profile.

Unlike the overlay (where the TUI process itself anchors the tree), the CLI also roots at any live wt instance it finds in the process table, so the running TUI counts as "us" rather than showing up as an outsider.

### `wt base <slug>` / `wt base set <slug> <ref>` / `wt base clear <slug>`

Show / record / forget a worktree's fork base — the branch it's based on when that isn't trunk. This record is the stack primitive (see [stacked-prs.md](stacked-prs.md)): the TUI's base row, stack grouping, sync counts, diff, and AI summary all resolve against it, and `wt restack` replays onto it.

### `wt status [<slug>] [<state>] [-m <note>] [--risk <r>]`

Show or assert a worktree's **work status** — the agent-declared lifecycle state (`todo`, `working`, `review`, `needs-testing`, `needs-human`, `ready`), rendered as the list pane's leftmost colored dot and used for the section-internal auto-sort (`[ui] sort`). The primary caller is a coding agent inside the worktree (cwd resolves the target; a slug/branch arg overrides), and the output deliberately teaches: every transition prints a short guidance footer with the expected next step, bare `wt status` prints the vocabulary (inside a worktree *and* outside one — outside, it adds a "pass a slug" hint instead of erroring), and errors restate the rules. `WT_NO_HINTS=1` silences the footers.

The rules that make statuses trustworthy are enforced here (the TUI's `u` picker is deliberately lenient for the human):

- `needs-human` requires `-m` naming exactly what's needed AND what was already tried ("blocked on X; tried Y, Z") — it's the only state that means "the human must act".
- `ready` requires `--risk low|medium|high` (judged broadly: end users, coworker workflows, costs, migrations), and medium/high additionally require `-m` naming the notable impacts. High-value notes only — nothing notable is `--risk low` with no note.

States accept unique prefixes plus `nh`/`nt` aliases. `--clear` drops the record, `--all [--json]` prints the fleet overview (the manager session's eyes) — the JSON form carries each row's manual `section` (the human's grouping intent) and appends the same recently-removed rows as `wt ls --json` (`kind: "merged"|"removed"`, `pr`, `archived_at`), so an all-merged fleet is distinguishable from an empty one. `--note-only "..."` amends just the note of an existing record, keeping the state, risk, and `at` timestamp (it errors when no status is asserted) — for sharpening a needs-human note or adding late-learned merge impacts without faking a fresh assertion. Each record stamps the assert time and HEAD sha, so both the CLI and the details-pane `status` row can flag a status that predates newer commits. Re-asserting an identical status (same state, note, risk, and HEAD) is a no-op that keeps the original timestamp — agents and hooks can assert freely without re-narrating (and re-toasting) the same news in every watching TUI. Statuses also ride `wt ls --json` (`work_state`/`work_note`/`work_risk`/`work_at`), which carries them across SSH for remote worktrees.

### `wt edge [<from> <kind> <to>]`

Merge edges: **pairwise, self-expiring** ordering hints between worktrees — the structured form of "merge A before B" that used to live only in manager prose ([fleet.md](fleet.md#the-design-responses) has the design rationale). `wt edge <from> before <to> [--blocks|--prefer] [-m why]` asserts (kinds: `before`, `enables` — orders the same, names a truth dependency; `conflicts` — same-files sequencing, direction irrelevant, no ordering effect; unique prefixes accepted). Bare `wt edge` lists (`--json` for machines, with computed `stale`), `wt edge rm <from> <to>` drops. Endpoints accept slugs or branches; `by` records the asserting worktree (cwd) or `fleet`.

Every edge anchors both endpoints' HEAD SHAs at assert time and **expires when either branch moves** — stale edges grey in listings and stop steering the TUI sort until re-asserted (the CLI refuses an edge whose anchors can't be resolved: an edge that can't self-expire is worse than none). Edges with a merged/destroyed endpoint are dropped at reap. The TUI topologically orders rows within their section to honor fresh edges; `--blocks` vs `--prefer` (the default) tells the human which edges are safe to deliberately violate — nothing ever gates a merge.

### `wt fleet`

The [manager session](manager.md)'s single audit surface: one row per live worktree joining the **asserted** work status (state, note, risk, `at`, staleness vs HEAD) with observable **reality** — the primary Claude session's liveness (`alive`/`busy`/`last_activity`/`agent_name`, the same signals as `wt claude ls --json`) and the PR (number, title, draft, merge state, mergeability, CI rollup), all from the same single batched GraphQL round trip the TUI uses (never per-row `gh` calls). Each row also carries the human's manual TUI **section** — a second channel of asserted intent alongside the work status (a name like "Merge after Release" is a merge-ordering hint the manager should weigh; `null`/`—` = inbox, and inferred stack groupings never appear — those are derivable from base records and PRs). Rows sort ready-first, then needs-human (the TUI's urgency ranking), and the recently-removed rows ride along like on every fleet surface.

- `--json` — the contract. Live rows carry `section` plus nested `work`, `session`, and `pr` objects; when GitHub is unreachable (no `gh`, not authenticated, fetch failure) rows still emit with `pr: null` plus a `pr_note` saying why — so "no PR" (`pr` and `pr_note` both null) stays distinguishable from "couldn't ask". Removed rows are the same `kind: "merged"|"removed"` entries as `wt ls --json`; live rows never carry `kind`.

Merge fields (`merge_state` from GitHub's `mergeStateStatus`, `mergeable`) are lowercased GitHub enums with one twist: GitHub computes mergeability **lazily**, so its `UNKNOWN` is reported as `"computing"` and wt never polls — re-run after a few seconds if you need the answer (the query itself is what triggers the computation). On terminal (merged/closed) PRs the merge fields are null rather than eternally "computing".

### `wt manager` / `wt manager send <text…>` / `wt manager report [--ok|--warn|--err] <text…>`

Attach the singleton [manager session](manager.md) (create on first use), or inject a message into it — the fire-and-forget outbound channel for worktree agents and scripts, carrying both fleet-level questions and `papercut:` reports (`wt manager send` cold-starts the session detached when it isn't running; the message lands as its next turn, and nothing comes back). Same session the TUI's `m` key enters.

`wt manager report` is the reverse channel: it appends a short result line to a spool a running TUI watches and surfaces on the **attention feed** (with a toast). It's how [`M` palette](manager.md#the-command-palette-m) commands hand their outcome back without the human attaching; the level flag (default `info`) picks the line's color/loudness. Reports while no TUI runs aren't replayed later — it's a live-delivery channel, not a log (the daily log records whatever surfaced).

### `wt issue <slug>` / `wt issue <slug> --gh <n>` / `wt issue <slug> --clear-gh`

Show or edit a worktree's issue links. The **primary** id is parsed from the slug (`eng-1935-…` → `ENG-1935`) and is never stored or edited here — it's the worktree's identity. The **secondary** GitHub issue is a per-slug record attached with `--gh <n>` (typically after a spec/breakout issue is created mid-work) and detached with `--clear-gh`; it never changes the branch. The TUI's `i` key and `y i` yank treat an attached GitHub issue as the most-specific link target; `I` / `y I` always target the primary. `<slug>` also accepts a branch name. Both ids appear in `wt ls --json` (`issue_id`/`issue_url`, `gh_issue`/`gh_issue_url`).

## Stacked PRs

### `wt restack [<branch>] [--onto <ref>]`

Rebase the stack containing `<branch>` (default: the current worktree's branch) onto its updated parents — see [stacked-prs.md](stacked-prs.md). Fetches, reconciles each member's fork-base record against landed PRs (a merged parent reparents its children, anchors preserved), then squash-safe-replays every member onto its parent, force-pushes (skipped for branches with no origin counterpart), and retargets PR bases. A standalone worktree is just a one-member chain: it rebases onto its recorded base, or plain trunk when there's no record — so this (and the TUI's `R`) works on every worktree, not only stacks. `--onto <ref>` overrides the trunk the roots land on.

On a merge conflict it exits 3 and names the failing branch + backup branch — `wt` never auto-resolves conflicts; the `/restack` skill (or you) does.

### `wt restack prune-backups [--days <n>]`

Delete the engine's `backup/restack-*` branches older than `--days` (default all).

### `wt skills [status|sync|diff|reset]`

Keep wt's bundled agent skills (`wt`, `restack`, `manager`, `start`, `triage`) and the managed instructions block installed and current across every harness on the machine — following symlinks, deduping shared directories, and writing through rulesync pipelines (durable source + regenerate) where one manages the target. See [skills.md](skills.md) for the full model.

- `wt skills` / `status` — freshness of every unit at every target, plus remembered template answers.
- `sync [<name>...]` — interactive install/update; the same flow the TUI runs at startup. `--yes` accepts all missing/outdated units without prompting (never touches modified copies); `--force` additionally allows overwriting modified copies. Naming a unit explicitly overrides a remembered decline. `install` is a legacy alias.
- `diff <name>` — what a sync would change, as a unified diff.
- `reset [--answers|--declines]` — forget remembered template answers and/or declined updates.

### `wt update [log] [--check] [--head]`

Update wt itself. The install is a git clone (see the README), so updating is a fast-forward: `git fetch`, `git merge --ff-only`, and a `bun install` when the dependency manifest changed across the jump. Two safety layers ride along (semantics: [updates.md](updates.md)): the target is the newest incoming commit whose **CI is green** (red/still-running commits are held back; missing checks and API failures fail open), and the result is **boot-probed** in a child process — a version that fails the probe is reverted and skipped until origin moves again. Prints the incoming commits before applying and names any still-running wt instances afterwards; they keep the old code until restarted. Refuses to touch a clone with local changes or unpushed commits; update those by hand with git.

- `log` — print the update/rollback journal plus current / last-good / skipped shas.
- `--check` — only report whether an update is available; don't apply.
- `--head` — ignore the CI gate and target origin's tip.

The TUI runs the same check at startup, before the terminal is taken over: at most once a day, prompting y/n, with a "no" remembered per offered version — it never re-asks until the offer changes. Skipped silently when the clone is dirty/ahead (a wt being developed updates itself by hand). An accepted update re-execs wt so the fresh code is what actually runs. `[update] startup_check = false` ([configuration.md](configuration.md#update)) disables the startup check; `WT_UPDATE=off` disables the whole update system for a single run (the probe harness arms this). The check's daily stamp, journal, and remembered declines live in `~/.cache/wt/update.json`, shared machine-wide like the skills memory.

### `wt rollback [<ref>]`

Reset the wt source clone to a previous version — by default the last one that completed a healthy boot (see [updates.md](updates.md)). Syncs dependencies across the jump, journals the move, and skips the abandoned version in future startup offers until new commits land on origin (`wt update` can always re-apply it explicitly). Refuses dirty/ahead clones. wt also *offers* this automatically: when a freshly-updated version crashes (default yes) or when a previous start of it never finished booting (default no).

### `wt version`

Print the running version — the source clone's git short hash and commit date (`98d1250 (2026-08-08)`), with a `-dirty` suffix when the clone has local modifications. Notes when origin is ahead as of the last fetch (touches no network; `wt update --check` does the live comparison). Also available as `wt --version` / `-v`, and shown in the title of the TUI's help overlay (`?`).

## Integrations

### `wt events <sub>`

The optional GitHub webhook daemon — see [github-events.md](github-events.md).

| sub | what it does |
|---|---|
| `install` | write the launchd agent + generate the HMAC secret; prints the values to paste into GitHub's webhook settings |
| `start` / `stop` | load / unload the launchd agent |
| `status` | liveness, bind address, pid, delivery count, last fetch/error, snapshot age |
| `secret` | generate or show the HMAC secret |
| `uninstall` | unload + remove the launchd agent |
| `serve` | run the daemon in the foreground (what launchd invokes) |

### `wt claude <sub>`

Drive a worktree's Claude Code tmux session from scripts or other sessions.

| sub | what it does |
|---|---|
| `send <slug> [text...]` | upsert the target's primary Claude session (cold-starts it if absent) and paste + submit the text; reads stdin when no text args (heredoc-friendly). Accepts a branch name in place of the slug, plus the repo-level session slugs `wt` / `main` / `dotfiles` / `manager` (the same targets `ls` lists; `manager` is the same session as `wt manager send`). A slug in the recent removed history answers with why it's gone ("archived on merge (#N, 2h ago)") instead of a bare "no worktree"; anything else errors naming the addressable set. Fire-and-forget as to the *result*, but **delivery is confirmed**: the prompt has to show up in the session's own transcript (as a message or a queued one) before this reports success, so a send that a modal swallowed exits non-zero and says so instead of printing a tick. A cold start that swallowed the prompt is re-sent once automatically |
| `ls [--json]` | list slugs with a live Claude session. `--json` adds per-session `name`, `agent_name`, `alive`, `busy`, and `last_activity` (the last two from Claude's live process registry, matched by cwd + session name; `null` when the tmux session has no registered claude process). `agent_name` is the label the session registered under **when it matches the name wt would have given it** — the address a peer Claude instance can message it by directly; `null` means there's no usable address (no registered process, or a session labelled before names became slug-derived) and `send` is the way to reach it |
| `kill <slug>` | kill the worktree's primary Claude session |

---

There is also an internal `wt _destroy` entrypoint that `rm --background` / `clean` spawn for background removals — not for direct use.
