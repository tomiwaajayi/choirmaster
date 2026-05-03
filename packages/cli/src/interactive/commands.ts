/**
 * Slash-command registry. One source of truth for /help, slash
 * suggestions, and dispatch routing.
 *
 * Routing here only translates the slash form into the argv that the
 * top-level CLI dispatcher already understands. Heavy logic stays in
 * commands/*.ts so this module is safe to import from tests.
 */

export interface ShellCommand {
  name: string
  summary: string
  /** Brief usage string shown in /help. */
  usage: string
  /**
   * Translate slash args into the argv the top-level CLI accepts.
   * Returning null means "do not dispatch" (handled in the shell loop:
   * /help and /exit are intercepted before dispatch).
   */
  toCliArgs?: (args: string[]) => string[] | null
}

export const SHELL_COMMANDS: ShellCommand[] = [
  {
    name: '/draft',
    summary: 'Create or refine a markdown plan',
    usage: '/draft [goal...]   /draft --interactive [goal]   /draft --from notes.md',
    toCliArgs: (args) => ['draft', ...args],
  },
  {
    name: '/plan',
    summary: 'Generate a task contract from a markdown plan',
    usage: '/plan [plan.md|@query]',
    toCliArgs: (args) => ['plan', ...args],
  },
  {
    name: '/run',
    summary: 'Run a markdown plan end to end',
    usage: '/run [plan.md|@query]',
    toCliArgs: (args) => ['run', ...args],
  },
  {
    name: '/resume',
    summary: 'Continue a paused or interrupted run',
    usage: '/resume [run-id]',
    toCliArgs: (args) => (args.length === 0 ? null : ['--resume', ...args]),
  },
  {
    name: '/doctor',
    summary: 'Check local setup',
    usage: '/doctor',
    toCliArgs: (args) => ['doctor', ...args],
  },
  {
    name: '/help',
    summary: 'Show available commands',
    usage: '/help',
  },
  {
    name: '/exit',
    summary: 'Leave ChoirMaster',
    usage: '/exit',
  },
]

// Object.create(null) avoids surfacing prototype-chain entries
// (toString, __proto__, etc.) when a malformed name is looked up.
const COMMANDS_BY_NAME: Record<string, ShellCommand> = Object.create(null)
for (const cmd of SHELL_COMMANDS) COMMANDS_BY_NAME[cmd.name] = cmd

// /quit is a courtesy alias for /exit. Not advertised in /help to keep
// the surface tight, but won't surprise users coming from other shells.
COMMANDS_BY_NAME['/quit'] = COMMANDS_BY_NAME['/exit']!

export function findShellCommand(name: string): ShellCommand | undefined {
  // Case-insensitive: typing /RUN should resolve to /run. We lowercase
  // before lookup so the suggestion engine and the dispatcher agree on
  // what "the same command" means.
  if (typeof name !== 'string') return undefined
  return COMMANDS_BY_NAME[name.toLowerCase()]
}

export function listShellCommandNames(): string[] {
  return SHELL_COMMANDS.map((cmd) => cmd.name)
}
