/**
 * `choirmaster` library + CLI entry.
 *
 * Two surfaces in one file:
 *
 *  1. Library re-exports: everything a user's `manifest.ts` needs to
 *     declare a project (`defineProject`, branch policies, the worktree
 *     sandbox, the Claude agent factory, types). Internal workspace
 *     packages (`@choirmaster/core`, `@choirmaster/agent-claude`) are
 *     bundled into this output by tsup, so users install one package
 *     and import everything from `'choirmaster'`.
 *
 *  2. `main(argv)`: the CLI dispatch the bin shim calls. Subcommand
 *     routing lives here; the actual work belongs in command modules.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { doctorCommand } from './commands/doctor.js'
import { initCommand } from './commands/init.js'
import { planCommand } from './commands/plan.js'
import { runCommand } from './commands/run.js'

// ── Library re-exports ──────────────────────────────────────────────────────

export * from '@choirmaster/core'
export * from '@choirmaster/agent-claude'

// ── CLI ─────────────────────────────────────────────────────────────────────

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
  cm <command> [options]

Commands:
  doctor                         Check repo, manifest, agents, gates, and network
  init [--force]                Scaffold .choirmaster/ in the current repo
  plan <plan.md>                Decompose a markdown plan into a tasks file
  run <plan.md|tasks.json>      Plan-then-run a markdown plan, or run a tasks file
  run --resume <run-id>         Resume a paused or interrupted run

Plan options:
  --output <path>               Write the generated tasks file here
  --force, -f                   Overwrite an existing tasks file at the output path

Run options:
  --continue-on-blocked         Skip blocked tasks instead of halting
  --reuse-worktree              Allow reusing existing worktrees
  --no-auto-merge               Leave each task on its branch (no auto-merge)

Options:
  -v, --version                 Print version
  -h, --help                    Print this help

Coming soon:
  run --issue N                 GitHub issue input
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
  // (init, plan, run) are dispatched by their own branches below.
  const COMING_SOON: Record<string, string> = {
    status: 'Show all runs and their states',
    reset: 'Reset blocked tasks in a run',
  }

  if (command === 'init') {
    return initCommand({
      force: args.includes('--force') || args.includes('-f'),
    })
  }

  if (command === 'doctor') {
    return doctorCommand()
  }

  if (command === 'plan') {
    const argList = args.slice(1)
    const outputIdx = argList.indexOf('--output')
    let outputFile: string | undefined
    const consumed = new Set<number>()
    if (outputIdx !== -1) {
      outputFile = argList[outputIdx + 1]
      if (!outputFile) {
        process.stderr.write('--output requires a path.\n')
        return 64
      }
      consumed.add(outputIdx)
      consumed.add(outputIdx + 1)
    }
    // Skip anything that looks like an option (starts with `-`), not just
    // double-dash long flags. Otherwise `choirmaster plan -f plan.md`
    // would pick `-f` as the positional plan file and fail before the
    // real path is read.
    const planFile = argList.find((a, i) => !consumed.has(i) && !a.startsWith('-'))
    if (!planFile) {
      process.stderr.write('Usage: choirmaster plan <plan.md> [--output <tasks.json>] [--force]\n')
      return 64
    }
    return planCommand({
      planFile,
      outputFile,
      force: args.includes('--force') || args.includes('-f'),
    })
  }

  if (command === 'run') {
    const argList = args.slice(1)

    // --resume <run-id> takes precedence over a positional input.
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

    const inputFile = argList.find((a, i) => !consumed.has(i) && !a.startsWith('--'))
    if (resumeRunId && inputFile) {
      process.stderr.write(
        `Pass either a plan/tasks file or --resume, not both. (got both '${inputFile}' and --resume ${resumeRunId})\n`,
      )
      return 64
    }
    if (!resumeRunId && !inputFile) {
      process.stderr.write(
        'Usage:\n'
        + '  choirmaster run <plan.md|tasks.json> [--continue-on-blocked] [--reuse-worktree] [--no-auto-merge]\n'
        + '  choirmaster run --resume <run-id>\n',
      )
      return 64
    }

    // Plan-then-run: when the input is a markdown file, run the planner
    // first, then dispatch the generated tasks file. Keeps the user-facing
    // shape simple (`run <plan.md>`) while preserving `run <tasks.json>`
    // for hand-authored or generated files. Plan-then-run forces overwrite
    // on the generated file because fresh planning is the explicit intent
    // of this entry point; standalone `choirmaster plan` defaults to
    // refusing overwrites so reviewed/edited tasks files don't get
    // clobbered by a re-plan.
    let tasksFile = inputFile
    if (inputFile && inputFile.toLowerCase().endsWith('.md')) {
      const planExit = await planCommand({ planFile: inputFile, force: true })
      if (planExit !== 0) return planExit
      tasksFile = inputFile.replace(/\.md$/i, '.tasks.json')
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
