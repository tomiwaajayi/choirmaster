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

Commands:
  init [--force]                Scaffold .choirmaster/ in the current repo
  run <tasks.json>              Run every pending task in the file
  run --resume <run-id>         Resume a paused or interrupted run

Run options:
  --continue-on-blocked         Skip blocked tasks instead of halting
  --reuse-worktree              Allow reusing existing worktrees
  --no-auto-merge               Leave each task on its branch (no auto-merge)

Options:
  -v, --version                 Print version
  -h, --help                    Print this help

Coming soon:
  plan <plan.md> | --issue N    Decompose a plan or GitHub issue into tasks
  status                        Show all runs and their states
  reset <run-id>                Reset blocked tasks in a run

Pre-alpha. https://github.com/tomiwaajayi/choirmaster
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
  // Unimplemented commands fall through to a "coming soon" stub so users
  // get a clear signal instead of "unknown command". Implemented commands
  // (init, run) are dispatched by their own branches below.
  const COMING_SOON: Record<string, string> = {
    plan: 'Decompose a plan or GitHub issue into a tasks file',
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
    const argList = args.slice(1)

    // --resume <run-id> takes precedence over a positional tasks file.
    const resumeIdx = argList.indexOf('--resume')
    let resumeRunId: string | undefined
    const consumed = new Set<number>()
    if (resumeIdx !== -1) {
      resumeRunId = argList[resumeIdx + 1]
      if (!resumeRunId) {
        process.stderr.write('--resume requires a run id.\n')
        return 64
      }
      consumed.add(resumeIdx)
      consumed.add(resumeIdx + 1)
    }

    const tasksFile = argList.find((a, i) => !consumed.has(i) && !a.startsWith('--'))
    if (resumeRunId && tasksFile) {
      process.stderr.write(
        `Pass either a tasks file or --resume, not both. (got both '${tasksFile}' and --resume ${resumeRunId})\n`,
      )
      return 64
    }
    if (!resumeRunId && !tasksFile) {
      process.stderr.write(
        'Usage:\n'
        + '  choirmaster run <tasks.json> [--continue-on-blocked] [--reuse-worktree] [--no-auto-merge]\n'
        + '  choirmaster run --resume <run-id>\n',
      )
      return 64
    }

    return runCommand({
      tasksFile,
      resumeRunId,
      continueOnBlocked: args.includes('--continue-on-blocked'),
      reuseWorktree: args.includes('--reuse-worktree'),
      skipAutoMerge: args.includes('--no-auto-merge'),
    })
  }

  if (command && command in COMING_SOON) {
    process.stderr.write(`choirmaster: '${command}' is not yet implemented.\n`)
    process.stderr.write(`             ${COMING_SOON[command]}\n`)
    return 2
  }

  process.stderr.write(`choirmaster: unknown command '${command ?? ''}'\n\n`)
  process.stderr.write(HELP)
  return 64
}
