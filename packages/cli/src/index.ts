/**
 * @choirmaster/cli entry point.
 *
 * Exposes `main(argv)` for the bin shim to call. Kept tiny on purpose:
 * subcommand routing lives here, the actual work belongs in @choirmaster/core
 * and provider packages.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Pkg {
  version: string
  name: string
}

function readPkg(): Pkg {
  const here = dirname(fileURLToPath(import.meta.url))
  // dist/index.js is one level deep; package.json is one level up. From
  // src/index.ts during dev (tsx) it's the same relative offset.
  const pkgPath = join(here, '..', 'package.json')
  return JSON.parse(readFileSync(pkgPath, 'utf8')) as Pkg
}

const HELP = `choirmaster - agentic-coding orchestrator

Usage:
  choirmaster <command> [options]

Commands (planned; not yet implemented):
  init                       Scaffold .choirmaster/ in the current repo
  plan <plan.md>             Decompose a plan into tasks (planner + reviewer loop)
  plan --issue <n>           Decompose from a GitHub issue
  plan --label <name>        Decompose from issues with a label
  run <plan.md>              Execute every task in order
  run --issue <n>            Execute from a GitHub issue
  status                     Show all runs and their states
  reset <run-id>             Reset blocked tasks in a run

Options:
  -v, --version              Print version
  -h, --help                 Print this help

Status: pre-alpha. Subcommands print "not yet implemented" placeholders.
See https://github.com/tomiwaajayi/choirmaster for progress.
`

export async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2)

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    process.stdout.write(HELP)
    return 0
  }

  if (args.includes('-v') || args.includes('--version')) {
    const pkg = readPkg()
    process.stdout.write(`${pkg.version}\n`)
    return 0
  }

  const command = args[0]
  const KNOWN: Record<string, string> = {
    init: 'Scaffold .choirmaster/ in the current repo',
    plan: 'Decompose a plan into tasks',
    run: 'Execute a plan',
    status: 'Show all runs and their states',
    reset: 'Reset blocked tasks in a run',
  }

  if (command === 'init') {
    const { initCommand } = await import('./commands/init.js')
    return initCommand({
      force: args.includes('--force') || args.includes('-f'),
    })
  }

  if (command === 'run') {
    const { runCommand } = await import('./commands/run.js')
    const tasksFile = args[1]
    if (!tasksFile) {
      process.stderr.write('Usage: choirmaster run <tasks.json> [--continue-on-blocked] [--reuse-worktree] [--no-auto-merge]\n')
      return 64
    }
    return runCommand({
      tasksFile,
      continueOnBlocked: args.includes('--continue-on-blocked'),
      reuseWorktree: args.includes('--reuse-worktree'),
      skipAutoMerge: args.includes('--no-auto-merge'),
    })
  }

  if (command && command in KNOWN) {
    process.stderr.write(`choirmaster: '${command}' is not yet implemented (pre-alpha).\n`)
    process.stderr.write(`             ${KNOWN[command]}\n`)
    return 2
  }

  process.stderr.write(`choirmaster: unknown command '${command ?? ''}'\n\n`)
  process.stderr.write(HELP)
  return 64
}
