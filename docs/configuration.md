# Configuration reference

`wt` first reads a user TOML file, resolved in this order:

1. `$WT_CONFIG` (explicit path override)
2. `$XDG_CONFIG_HOME/wt/config.toml`
3. `~/.config/wt/config.toml`

It then searches from the current directory upward for the nearest `.wt.toml` and recursively merges that repository config over the user config. This lets one user config hold personal defaults while each repository supplies its own clone, worktree root, trunk branch, integrations, actions, and other overrides. Run `wt` from within the repository you want to manage.

TOML tables merge by key. Scalar values and arrays replace the user value completely, so a repository's `[[actions]]` or `[[automations]]` list is authoritative when present. `$WT_CONFIG` selects a different user config; it does not disable repository overrides. Internally, `wt` carries the selected repository file into child processes with `$WT_REPO_CONFIG`, which also provides an explicit repository-config path for scripts that cannot preserve the invocation directory.

For example, shared personal defaults can live in `~/.config/wt/config.toml`:

```toml
[branch]
prefix = "yourname"

[ui]
mode = "classic"
```

Each repository can then provide the required paths and any project-specific settings in `.wt.toml`:

```toml
[paths]
main_clone    = "~/Code/project-a"
worktree_root = "~/Code/project-a-wt"

[branch]
base = "develop"
```

The repository file may be committed when its values are useful to every contributor, or ignored when it contains machine-specific paths.

The loader is fail-fast: it validates the merged result at startup and exits with **one aggregated error message** listing every missing or malformed field. A user config file must exist, but required fields may come from either layer. When `[paths]` is missing and no `.wt.toml` was found from the current directory upward, the error names both candidate homes — run `wt` inside the repo, or keep `[paths]` in the user config as the fallback. There is no hot reload; edits require restarting `wt`.

Only three fields are required in the merged result. Everything else has a generic default or is an optional integration that turns on when its section is present.

```toml
[paths]
main_clone    = "~/Code/your-repo"
worktree_root = "~/Code/your-repo-wt"

[branch]
prefix = "yourname"
```

The source of truth for the schema is [`src/core/config.ts`](../src/core/config.ts).

## `[paths]`

| key | required | default | meaning |
|---|---|---|---|
| `main_clone` | **yes** | — | The primary clone of the repo the worktrees belong to. |
| `worktree_root` | **yes** | — | Directory where worktrees are created (`<worktree_root>/<slug>`). |
| `log_dir` | no | `~/.cache/wt/logs` | Per-worktree destroy logs live here; daily structured app logs go to the derived `<log_dir>/app` subdirectory. |
| `lock_dir` | no | `~/.cache/wt/locks` | Per-slug operation locks (what drives the "setting up…" busy state). |
| `cache_db` | no | `~/.cache/wt/cache.sqlite` | SQLite blob persisting the TanStack Query cache between runs. |
| `wezterm_cli` | no | macOS: `/Applications/WezTerm.app/Contents/MacOS/wezterm`; elsewhere: `wezterm` from `PATH` | WezTerm CLI executable used to set the tab title to `wt` when `WEZTERM_PANE` is present. Supports `~` expansion. |

## `[branch]`

| key | required | default | meaning |
|---|---|---|---|
| `prefix` | **yes** | — | Branches you create become `<prefix>/<id>-<slug>`. Also seeds the `[stage]` defaults. |
| `base` | no | `"main"` | Trunk branch name. Diff bases, sync counts, merge detection all resolve against `origin/<base>`. |
| `id_pattern` | no | `"^[a-z]+-(\\d+)(?:-|$)"` | Regex (no flags) matching an issue ID at the start of a slug. The default matches Linear/Jira/Shortcut-style ids (`eng-1234`, `inf-99`). |
| `slug_max_len` | no | `50` | Slugs generated from issue titles are truncated to this length. |

## `[remote]` — optional SSH worktree host

Configure a second machine whose own `wt` installation, clone, config, and
worktree root remain authoritative. The local TUI polls that host's worktree
summaries and renders them in the same Inbox with a remote glyph. `Ctrl+N`
forwards the normal `wt new` lifecycle over SSH; F10/F11/F12 on one of those
rows attach to that worktree's remote tmux shell, diff, or AI session. Ordinary
`n` / `N` continue to create locally.

The last successful remote inventory is persisted with the rest of wt's query
cache. If the host sleeps or becomes unreachable, those rows remain visible as
last-known state and are marked `host unavailable`; they are not interpreted as
deleted worktrees.

```toml
[remote]
host = "cachy"                 # SSH host or ~/.ssh/config alias
label = "cachy"                # optional; defaults to host
wt_path = "~/.wt/bin/wt"       # optional
```

| key | required | default | meaning |
|---|---|---|---|
| `host` | **yes** | — | SSH destination or alias used by `ssh`. |
| `label` | no | `host` | Short name in the prompt, event log, and remote WezTerm tab title. |
| `wt_path` | no | `~/.wt/bin/wt` | Remote executable. The `~/` prefix expands in the remote account. |

The remote machine needs its own `~/.config/wt/config.toml`; do not point the
local process at a mounted remote filesystem. `wt remote [args…]` remains a
diagnostic/admin escape hatch, but normal work happens from the unified local
Inbox.

## `[stage]`

Preview-stage naming, used by the SST integration and stage URLs.

| key | required | default | meaning |
|---|---|---|---|
| `prefix` | no | `"<branch.prefix>-"` | Every per-worktree stage is `<prefix><slug-derived-name>`; the prefix guard is what keeps `wt` from ever touching stages it doesn't own. |
| `default_personal` | no | `branch.prefix` | Stage name reserved for your personal environment; excluded from orphan cleanup. |
| `domain` | no | *(unset)* | Public domain for building per-stage preview URLs (`https://<stage>.<domain>`). Unset ⇒ no stage URLs are constructed. |

## `[lifecycle]`

| key | required | default | meaning |
|---|---|---|---|
| `env_files_to_copy` | no | `[".env"]` | Files copied from the main clone into each new worktree during setup. |
| `install_command` | no | *(auto-detect)* | Dependency install run in a fresh `git-worktree` checkout, via `$SHELL -lc`. Unset ⇒ detect the package manager from the checkout's lockfile (`bun.lock`/`bun.lockb` → `bun install`, `pnpm-lock.yaml` → `pnpm install`, `yarn.lock` → `yarn install`, `package-lock.json`/`npm-shrinkwrap.json` → `npm install`); no lockfile ⇒ the install is skipped with a note. The `rift` backend never installs — packages ride the CoW clone. |

`install_command` caveats: the same command is also used verbatim for the main-clone dependency sync ([backends.md](backends.md)), so it must not rewrite the committed lockfile (use a frozen/`ci` variant) — auto-detection picks frozen variants for that path on its own. The command string is echoed into logs and the activity pane, so don't embed secrets in it. And like `[[actions]]`/`[[automations]]`, it executes automatically — a `.wt.toml` is trusted config, so don't point `wt` at repository config you don't control.

## `[backend]` — optional

Selects how a new worktree is materialized on disk. Omit the whole section for the default. See [backends.md](backends.md) for the full semantics.

| key | required | default | meaning |
|---|---|---|---|
| `kind` | no | `"git-worktree"` | `"git-worktree"` uses `git worktree` (one shared object db). `"rift"` uses copy-on-write clones via the [`rift`](https://github.com/anomalyco/rift) binary — near-instant, `node_modules` copied for free, each checkout an independent clone. |

```toml
[backend]
kind = "rift"
```

The `rift` backend needs the `rift` binary (`npm i -g rift-snapshot`); wt runs `rift init` on the main clone lazily at first create. wt looks for the executable on its own `PATH` first, then asks your login shell (`$SHELL -lc`) — so a wt spawned from a lean environment (launchd, an editor task) still finds a `~/.bun/bin/rift` that only your shell profile adds, and a shell *function* named `rift` can't shadow the real binary. Existing checkouts of the other kind keep working after a flip — the backend that owns a checkout is detected from disk (a `.rift` marker) at removal, never stored. Under `rift`, packages arrive via the CoW clone, so wt skips its own install step and the `--no-install` flag is ignored.

## `[deploy.sst]` — optional integration

Omit the whole section to disable SST awareness entirely — the stage row, `wt stages`, deploy detection, and the per-worktree stage pinning during `wt new` (no `.sst/stage` file is written, and the create output drops its stage line). When present, all three keys are required.

| key | required | default | meaning |
|---|---|---|---|
| `state_bucket` | **yes** | — | S3 bucket holding SST's Pulumi state. |
| `state_prefix` | **yes** | — | Key prefix within the bucket (SST v3 convention: `<state_prefix><stage>.json`). |
| `aws_profile` | **yes** | — | AWS CLI profile with read access to the state bucket. |
| `auto_regen_paths` | no | `["sst-env.d.ts"]` | Files in the main clone that `sst` runs regenerate; restored before fetches so they never show as dirt. |

## `[issue_tracker]` — optional integration

Omit the section entirely to hide the `issue` row. The section's mere presence surfaces the issue id parsed from the branch slug (`michael/coz-1883-fix` → `COZ-1883`) as an unlinked value — useful when your tracker has no per-task URLs. Add `url_template` (or the Linear preset) to turn the id into a deep link, which also powers the `i` open-issue key and the `y i` yank.

```toml
# Bare id display only — no per-task URLs exist:
[issue_tracker]

# Generic tracker with task URLs:
[issue_tracker]
url_template = "https://tracker.example.com/browse/{id}"

# Linear preset (derives url_template = "linear://<workspace>/issue/{id}"):
[issue_tracker.linear]
workspace = "acme"
```

| key | required | default | meaning |
|---|---|---|---|
| `url_template` | no | *(unset)* | URL with an `{id}` placeholder, substituted with the uppercased issue id parsed from the slug (no API calls, no token). Wins over the Linear preset when both are set. |
| `linear.workspace` | no | — | Linear preset: derives `url_template = "linear://<workspace>/issue/{id}"` (the desktop-app deep-link scheme). |

Id parsing itself is driven by the slug shape (`[a-z]+-\d+`), independent of `[branch] id_pattern`.

## `[ai]` — optional integration

Omit to disable the AI-generated title/brief/description in the details pane. Two providers:

```toml
# OpenAI-compatible endpoint (LM Studio, Ollama, llama.cpp, an actual OpenAI-style server…)
[ai]
endpoint = "http://127.0.0.1:1234"   # required for provider = "openai"
model    = "gemma-3-e4b-it-mlx"

# or Gemini
[ai]
provider    = "gemini"
model       = "gemini-3.5-flash"
api_key_env = "GEMINI_API_KEY"       # required for provider = "gemini"
```

| key | required | default | meaning |
|---|---|---|---|
| `provider` | no | `"openai"` | `"openai"` or `"gemini"`. |
| `model` | **yes** | — | Model id as the provider names it. |
| `endpoint` | openai: **yes** | gemini: `https://generativelanguage.googleapis.com/v1beta` | Base URL, no trailing slash. |
| `api_key_env` | gemini: **yes** | — | Name of the environment variable holding the Gemini API key. |
| `max_input_tokens` | no | `8000` | Soft prompt budget; diff hunks are dropped largest-first to stay under it. |
| `timeout_ms` | no | `120000` | Per-request timeout. Generous by default because local LLMs cold-start slowly. |

Summaries are content-addressed by a hash of the diff, so identical diffs (across rebases, amends, branch renames) reuse the cached result.

## `[github]`

| key | required | default | meaning |
|---|---|---|---|
| `ignored_checks` | no | `[]` | Glob patterns (case-insensitive, `*` wildcard only) matched against check names; matching contexts are dropped from the PR checks rollup so non-CI checks don't flip the badge. The configured `[review_bot]`'s `check_contexts` are always excluded automatically — no need to repeat them here. |
| `default_reviewer` | no | *(unset)* | GitHub login requested by the `E` ("ship it") chord (mark ready + request reviewer + arm auto-merge). Unset disables the reviewer leg. |
| `pr_target` | no | `"github"` | Where `p` opens PRs: `"github"` keeps GitHub URLs, `"linear"` rewrites them to Linear Reviews deep-links. `g p` / `l p` always open GitHub / Linear explicitly. |

## `[review_bot]` — the bot-review track

The badge/row/automation track for an automated PR reviewer. Omit the whole section for the default **CodeRabbit** preset — the exact behavior wt always had. Configure it to point the track at any other bot; the bot's own check contexts are always excluded from the CI rollup (an advisory reviewer must never flip the checks badge — it has its own badge).

Two "unresolved" models, selected by `unresolved_via`:

- `"threads"` (default, CodeRabbit-shaped): unresolved = review threads opened by `login` that aren't resolved.
- `"checklist"`: the bot posts a summary comment carrying a `- [ ]` task list; unresolved = unticked boxes in the latest summary comment (ticking a box in the GitHub UI is how items are accepted/dismissed). Use this when the bot posts via `github-actions[bot]` — that login is shared by every workflow, so the comment shape (`summary_marker`) is the discriminator.

```toml
# Example: an in-repo GitHub Actions "Codex review" workflow
[review_bot]
name           = "Codex"
login          = "github-actions"   # "[bot]" suffix optional
check_contexts = ["Codex code review", "Post Codex review", "Announce review started"]
unresolved_via = "checklist"
summary_marker = "### 🤖 Codex review"
pending_marker = "🤖 ⏳ Codex review started"
rerun_command  = "/codex-review"
```

| key | required | default | meaning |
|---|---|---|---|
| `name` | no | `"CodeRabbit"` | Display name (built-in re-run action label). |
| `login` | checklist: **yes** | `"coderabbitai"` | The bot's comment/thread author login. A trailing `[bot]` is ignored when matching (GraphQL reports app logins without it). Required in checklist mode — the CodeRabbit default would silently match nothing. |
| `check_contexts` | no | threads: `["CodeRabbit"]`, checklist: `[]` | Glob patterns for the bot's check contexts / workflow job names. Drive pending-vs-done detection and are auto-excluded from the CI rollup — set them whenever the bot runs as checks/jobs so an advisory run can't flip the CI badge. |
| `unresolved_via` | no | `"threads"` | `"threads"` or `"checklist"` (see above). |
| `summary_marker` | checklist: **yes** | — | Body prefix identifying the bot's summary comment. |
| `pending_marker` | no | *(unset)* | Body prefix of the bot's "review started" ack comment. An ack newer than the latest summary shows as *pending* — needed for comment-triggered re-runs, whose check runs never attach to the PR head. |
| `rerun_command` | no | *(unset)* | PR comment body that re-triggers a review. When set, a built-in "Re-run *name* review" action appears in the `!` picker (it posts the comment via `gh`). |

Checklist-mode bots typically don't re-run on push, so a review can lag the branch head. wt detects this (the latest summary comment predates the head commit) and marks the state **stale**: the details row shows `(old head)` and a stale *clean* dims instead of showing green. Badge states: pending (running / re-run acked), unresolved (with count), clean, none — unresolved wins over a concurrent re-run, since old findings still need addressing. Checkbox counting skips fenced code blocks, so a suggestion block quoting checkbox syntax doesn't inflate the count. One sizing note: the summary comment is found within the PR's most recent 30 comments — on an extremely chatty PR whose last 30 comments postdate the bot's summary, the badge reads as if the bot never ran.

The badge keeps the carrot glyph for CodeRabbit and switches to a robot glyph for any other login.

## `[github.events]` — optional webhook daemon

Omit for classic poll-only behavior. When present, the `wt events` daemon accepts GitHub webhook deliveries and pushes PR/check updates to the TUI instead of waiting on the poll. Setup walkthrough: [github-events.md](github-events.md).

| key | required | default | meaning |
|---|---|---|---|
| `port` | no | `8765` | Port the daemon listens on. |
| `host` | no | `"127.0.0.1"` | Bind address. Keep loopback when the public URL terminates on this machine; set a LAN IP / `0.0.0.0` only if a separate proxy box must reach it (the HMAC secret is then the only auth boundary). |
| `secret` | no | *(unset)* | Inline HMAC secret for `X-Hub-Signature-256` verification. Prefer `secret_file`; inline wins if both are set. |
| `secret_file` | no | *(unset)* | Path to a file holding the HMAC secret (home-expanded). `wt events install` generates one. |
| `backstop_poll_ms` | no | `600000` | github-query staleness bound while events are configured — only matters if the daemon dies or a delivery is dropped. |

## `[diff]`

| key | required | default | meaning |
|---|---|---|---|
| `command` | no | `"revdiff --vim-motion --compact {{base}}"` | Shell command F11 launches inside the selected worktree (via `$SHELL -lc`, so pipes and aliases work). `{{base}}` substitutes the worktree's resolved diff base: `origin/<trunk>` normally, the parent branch for stacked worktrees. Swap in `gitu`, `lazygit`, `tig status`, a `delta` pipe, or any script. Commands using `{{base}}` get their session killed when the resolved base changes (PR base flip, stack reroot) so the next F11 reopens against the right ref. |

## `[ui]`

| key | required | default | meaning |
|---|---|---|---|
| `rows` | no | `["branch", "base", "issue", "stage", "pr", "claude", "git"]` | Detail-pane row order. Available ids: `branch`, `base`, `path`, `issue` (legacy alias: `linear`), `stage`, `pr`, `claude`, `git`. Unknown ids are ignored; omitted ones are hidden. A row also hides itself when its integration isn't configured (e.g. `issue` without `[issue_tracker]`). The rebase state (restacking / mid-rebase / conflict + files) isn't a row — it renders as a fixed block below the rows, above the AI summary. |
| `mode` | no | `"classic"` | Which TUI a bare `wt` launches: `"classic"` (the three-pane worktree TUI) or `"hub"` (the tmux-hosted task-inbox layout, see [hub.md](hub.md)). Both modes read/write identical on-disk state; `wt classic` / `wt hub` force a mode regardless of this setting. |
| `hub_background` | no | `"#1E1E2E"` | `#RRGGBB` background color for hub mode's task pane and the outer tmux server's pane-border paint (see [hub.md](hub.md)). Defaults to the built-in Catppuccin Mocha base; set it to match your own terminal theme if you don't use that palette. |

## `[[actions]]` — the `!` menu

Pre-built actions surfaced by the `!` picker (and available as automation targets). Two kinds, distinguished by which field you set:

- **Prompt actions** (`prompt = "…"`): run the worktree's primary coding agent. Default delivery is a tracked headless run (`claude -p` / `codex exec` / `opencode run`); `target = "session"` instead injects the prompt into the live F12 session (fire-and-forget: no completion signal, so `affects` won't auto-refresh).
- **Shell actions** (`shell = "…"`): run `$SHELL -lc <shell>` in the worktree path; Enter launches directly with no edit step.

**Replacement semantics:** when `[[actions]]` is absent, two built-ins apply (`rebase-main` "Rebase on base", `address-review` "Address PR review"). The moment you define *any* entry, your list fully replaces the defaults — to drop one default, list everything you keep.

```toml
[[actions]]
id       = "deploy"
name     = "Deploy preview"
shell    = "pnpm deploy:local --stage {{stage}}"
group    = "deploy"        # optional picker section header
key      = "d"             # optional quick-pick letter (auto-derived when omitted)
requires = ["deployed"]

[[actions]]
id         = "fix-ci"
name       = "Fix failing CI"
prompt     = "CI is failing on the PR for this branch ({{pr}}). Investigate and fix, then push."
target     = "headless"    # or "session"
affects    = ["git", "github"]
arg_prompt = "extra context"      # optional: collect a per-launch {{arg}} value
label_extract = "^Fixed: (.+)$"   # optional: regex labeling history entries from run output
```

Fields:

| key | applies to | default | meaning |
|---|---|---|---|
| `id` | both | — (required) | Unique id; what `[[automations]].run` references. |
| `name` | both | — (required) | Picker label. |
| `prompt` / `shell` | — | — | Exactly one must be set; picks the kind. |
| `target` | prompt only | `"headless"` | `"headless"` or `"session"` (see above). |
| `affects` | both | prompt: `["git", "github"]`, shell: `[]` | State domains the action mutates; the matching caches are refreshed when the run exits. Tags: `git`, `github`. Explicit `[]` opts out. |
| `requires` | both | `[]` | Preconditions; unmet entries gray out in the picker with the reason. Tags: `pr` (any PR exists), `pr.ready` (open non-draft PR), `deployed` (this worktree's SST stage is live). |
| `key` | both | auto-derived | Single-char quick-pick letter in the `!` menu. |
| `group` | both | ungrouped | Section label; same-group actions cluster under one header. |
| `arg_prompt` | both | *(unset)* | Label for a per-launch value prompt. Picking the action first shows recent values (from `~/.cache/wt/action-history.json`) plus a "new…" input; the value substitutes `{{arg}}`. |
| `label_extract` | both | *(unset)* | Regex (source string, no flags) scanned against the run's output; the last per-line match (capture group 1, or the full match) becomes the history label for the `{{arg}}` value. |

**Template variables** (`{{var}}`, unknown vars pass through so typos are visible): `{{base}}` resolved diff base, `{{base_branch}}` parent branch or trunk, `{{branch}}`, `{{slug}}`, `{{cwd}}` worktree path, `{{pr}}` PR number or empty, `{{stage}}` the worktree's SST stage, `{{skill_prefix}}` the harness's skill-invocation prefix (`/` for Claude Code, `$` for Codex/OpenCode — write `{{skill_prefix}}restack` to invoke a skill portably), and `{{arg}}` for the collected `arg_prompt` value.

## `[[automations]]` — optional, strictly opt-in

Rules that fire actions (or built-in flows) automatically off PR and stack state ([stacked-prs.md](stacked-prs.md)). No defaults ship; an absent section means nothing is automated. Deep dive on the semantics (fire keys, settle windows, circuit breaker): [automations.md](automations.md).

```toml
[[automations]]
id  = "auto-restack"
on  = "stack.parent_merged"
run = "builtin:restack"

[[automations]]
id               = "auto-fix-ci"
on               = "pr.checks.failed"
run              = "fix-ci"          # an [[actions]] id
busy             = "queue"           # or "skip"
cooldown_minutes = 30
settle_seconds   = 300
```

| key | required | default | meaning |
|---|---|---|---|
| `id` | **yes** | — | Unique rule id (used in fire-key bookkeeping and logs). |
| `on` | **yes** | — | Trigger: `pr.checks.failed`, `review_bot.unresolved` (the `[review_bot]`'s findings; `rabbit.unresolved` is a legacy alias), `review.changes_requested`, `pr.conflict`, `wt.merged` (a non-stacked worktree landed), `stack.parent_merged` (a stack member's parent landed). |
| `run` | **yes** | — | An `[[actions]]` id, or a builtin: `builtin:restack` (only valid with `stack.parent_merged`), `builtin:clean` (any single-worktree trigger). |
| `busy` | no | `"queue"` | When the worktree isn't quiescent at delivery time: `queue` holds the intent until it settles, `skip` drops it. |
| `cooldown_minutes` | no | *(none)* | Minimum minutes between dispatches per (rule, worktree). |
| `settle_seconds` | no | `120` (merge triggers: `10`) | Quiescence window: the condition must hold and the worktree be edit-free this long before delivery. Doubles as your cancellation grace period. |

At runtime, `A` pauses all automations and `Ctrl+A` pauses the selected worktree (or its whole stack); both persist across restarts.
