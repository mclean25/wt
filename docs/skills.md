# Agent skills & instructions distribution

wt is the single source of truth for its own agent tooling. It bundles the
skills coding agents need to work well with wt (in `skills/` of the wt
checkout) plus a small always-on instructions block, and keeps the installed
copies current on your machine — across every harness, through whatever
symlink or rulesync topology your dotfiles use. The point is that you never
hand-maintain wt-related agent config: updates ship with `git pull` in the
wt checkout and offer themselves on the next launch.

## What gets distributed

| unit | what it is |
|---|---|
| `instructions` | a managed block spliced into each harness's **global instructions file** (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`): the always-on ownership rules for agents working in wt worktrees (work status, decision ownership and the `needs-human` refusal test, manual testing, the dev server) |
| `wt` skill | orientation: subcommands, conventions, the stacked-PR model, gotchas |
| `restack` skill | the conflict-resolution playbook behind `/restack` |
| `manager` skill | the fleet-coordinator playbook for the [manager session](manager.md) |
| `start` skill | kick off work inside a prepared worktree (brief → research → build → review → test → status hand-off) |
| `handoff` skill | move a distinct follow-up into a new worktree, write its `prompt.txt`, and start the configured primary agent |
| `shepherd` skill | the fleet sweep behind `/shepherd`: drive every row toward mergeable on a loop, stopping short of the merge |
| `triage` skill | turn a pasted task batch into prioritized, ready-to-work worktrees |

The instructions block exists because skills only load when invoked — the
ownership rules ("you own testing", "never end without a status") have to be
in the always-loaded instructions layer to actually govern behavior.

It's also the only layer that can *correct* a repo. A shared repo's own
`CLAUDE.md`/`AGENTS.md` is written for the contributors who don't use wt, so it
says things like "run `pnpm dev`" — always loaded, and wrong inside a worktree.
Adding a wt caveat there isn't an option (it would be noise for everyone else),
and a skill loses the race because it isn't loaded when the agent reads the
repo's table. The managed block is per-machine, always on, and therefore the
one surface that wins that argument — which is why the dev-server rule lives
there and not in the `wt` skill alone.

## The startup check

When the TUI starts (and before it takes over the terminal, so agents
spawned from that session see the updates), wt compares every unit against
what's installed and asks **y/n once per pending update**:

```
wt: 2 agent-skill update(s) available
• Install skill manager (playbook for the singleton manager session)? [Y/n]
~ start: existing copy was not installed by wt. Overwrite with the wt-managed version? [y/N]
```

- A **"no" is remembered per content version and per target** — you're never
  re-asked until the bundled content actually changes, and a decline for one
  install location never suppresses a later install to a new one (say, a
  freshly configured harness).
- Copies that wt didn't install (or that were edited afterwards) are never
  overwritten silently; they get the `[y/N]`-default prompt above.
- When applying goes through a rulesync pipeline, wt confirms the exact
  regenerate command it's about to run (`bash …/scripts/rulesync.sh`, or
  `npx rulesync generate`) once per pipeline before touching it.
- `[skills] startup_check = false` turns the startup prompt off entirely.

If a unit has template blanks (see below) you're asked once, and the answer
is remembered forever.

## How freshness is decided

Every file wt installs ends with a stamp comment, `<!-- wt-managed <hash> -->`,
where the hash covers the body above it. Comparing the installed body and
stamp against the current render distinguishes:

- **fresh** — matches the current bundled content
- **outdated** — an intact wt-managed copy of an older version (safe to update)
- **modified** — no stamp, or edited since install (yours; prompt-only, never auto)

The instructions block uses begin/end markers with the same hash scheme, so
everything OUTSIDE the block in your instructions file is untouched — wt only
ever rewrites the region between its own markers.

## Where things get installed

Detection follows the real filesystem, per harness present on the machine:

- **Native**: `~/.claude/skills/<name>/` (Claude; OpenCode reads the same
  dir), `~/.agents/skills/` or `$CODEX_HOME/skills/` (Codex), and the global
  instructions files listed above.
- **Symlinks are resolved and deduped**: when several harnesses point at one
  real directory (stow-style dotfiles, `.agents` → `.claude`), wt writes
  once and credits every harness it serves.
- **rulesync pipelines are first-class**: if the resolved location lives
  inside a repo with a `.rulesync/` dir, the generated output is a wipe-on-
  regenerate artifact — so wt writes to the durable SOURCE instead
  (`.rulesync/skills/<name>/`, and the `root: true` rules file for the
  instructions block) and then regenerates: via the repo's own
  `scripts/rulesync.sh` when it has one, else `npx rulesync generate`.
  One regenerate per sync, not per unit.

## Template values

Bundled content may carry `{{key}}` blanks for genuinely per-user text (for
example `project_notes` in the `start`/`triage` skills: your project's
design-review flow, testing tools, tracker quirks). Answers are collected
interactively the first time a unit needing them is installed, remembered in
`~/.cache/wt/skills.json`, and rendered into the installed copy. Changing an
answer (after `wt skills reset --answers`) makes the affected units show as
outdated — the render changed. Unanswered blanks render a sensible fallback;
nothing blocks on them.

## The CLI

```
wt skills                    # freshness of every unit at every target
wt skills sync [<name>...]   # interactive install/update (what startup runs)
wt skills sync --yes         # accept all missing/outdated; never touches modified
wt skills sync <n> --force   # non-interactive: also overwrite a modified copy
                             # (interactive runs always ask per modified copy)
wt skills diff <name>        # what a sync would change
wt skills reset              # forget remembered answers + declines
```

Naming a unit explicitly (`wt skills sync start`) overrides a remembered
decline — asking for it by name IS the re-ask. `wt doctor` shows a one-line
banner when updates are pending.

## Keeping your own versions

Prefer your own `start` skill? Decline the prompt once — wt remembers that
decision for that version and the fleet keeps working (the CLI's own
guidance output, `wt status` footers and friends, is always current
regardless of skills). `wt skills status` still shows the unit as
`local copy differs (declined for this version)` so the state stays visible
rather than silent.
