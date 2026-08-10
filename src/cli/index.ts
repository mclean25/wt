// Static imports so the TS project includes all command modules in
// type-checking. Runtime dispatch is still keyed by command name below.
import * as lsCmd from "./commands/ls.ts";
import * as newCmd from "./commands/new.ts";
import * as rmCmd from "./commands/rm.ts";
import * as cleanCmd from "./commands/clean.ts";
import * as doctorCmd from "./commands/doctor.ts";
import * as stagesCmd from "./commands/stages.ts";
import * as logsCmd from "./commands/logs.ts";
import * as perfCmd from "./commands/perf.ts";
import * as openCmd from "./commands/open.ts";
import * as baseCmd from "./commands/base.ts";
import * as issueCmd from "./commands/issue.ts";
import * as statusCmd from "./commands/status.ts";
import * as managerCmd from "./commands/manager.ts";
import * as claudeCmd from "./commands/claude.ts";
import * as devCmd from "./commands/dev.ts";
import * as restackCmd from "./commands/restack.ts";
import * as skillsCmd from "./commands/skills.ts";
import * as updateCmd from "./commands/update.ts";
import * as versionCmd from "./commands/version.ts";
import * as eventsCmd from "./commands/events.ts";
import * as remoteCmd from "./commands/remote.ts";
import * as remoteExecCmd from "./commands/_remote.ts";
import * as sessionExecCmd from "./commands/_session.ts";
import * as destroyCmd from "./commands/_destroy.ts";

const HELP = `usage: wt <command> [options]

commands:
  ls           list all worktrees
  new         create a new worktree
  rm          remove a worktree
  clean       remove merged/gone worktrees
  doctor      report health of worktree(s)
  stages      list SST stages, optionally clean orphans
  logs        tail a destroy log
  perf        one-shot perf snapshot: wt-downstream vs the rest of the machine
  open        open a worktree in Zed
  restack     rebase a stack of worktrees onto its updated parents
  skills      keep wt's agent skills + instructions installed and current
  update      update wt itself (fast-forward the source clone)
  version     print the running wt version (git short hash)
  events      manage the optional GitHub webhook daemon
  remote      enter or run wt on the configured SSH remote
  base        show / set / clear a worktree's recorded fork base
  status      show / assert a worktree's work status (agent-facing)
  manager     attach the fleet-coordinator session / send it a message / report a result
  issue       show a worktree's issue links / attach a GitHub issue (--gh)
  claude      drive a worktree's Claude Code session (send / ls / kill)
  dev         start / stop / inspect a worktree's [dev_server]

Run \`wt <command> --help\` for per-command options where available.`;

type Runner = (argv: string[]) => Promise<number>;

const RUNNERS: Record<string, Runner> = {
  ls: lsCmd.run,
  new: newCmd.run,
  rm: rmCmd.run,
  clean: cleanCmd.run,
  doctor: doctorCmd.run,
  stages: stagesCmd.run,
  logs: logsCmd.run,
  perf: perfCmd.run,
  open: openCmd.run,
  restack: restackCmd.run,
  skills: skillsCmd.run,
  update: updateCmd.run,
  version: versionCmd.run,
  events: eventsCmd.run,
  remote: remoteCmd.run,
  _remote: remoteExecCmd.run,
  _session: sessionExecCmd.run,
  base: baseCmd.run,
  status: statusCmd.run,
  manager: managerCmd.run,
  issue: issueCmd.run,
  claude: claudeCmd.run,
  dev: devCmd.run,
  _destroy: destroyCmd.run,
};

export async function dispatch(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  if (cmd === "--version" || cmd === "-v") {
    return versionCmd.run(rest);
  }
  const run = cmd ? RUNNERS[cmd] : undefined;
  if (!run) {
    console.error(`unknown command: ${cmd ?? ""}\n`);
    console.error(HELP);
    return 2;
  }
  return run(rest);
}
