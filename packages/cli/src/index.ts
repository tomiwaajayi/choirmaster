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

import { completionsCommand } from './commands/completions.js'
import { doctorCommand } from './commands/doctor.js'
import { draftCommand } from './commands/draft.js'
import { initCommand } from './commands/init.js'
import { planCommand } from './commands/plan.js'
import { runCommand } from './commands/run.js'
import { completeMarkdownReferences, formatMarkdownReferenceError, resolveMarkdownReference } from './markdown-ref.js'

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
  draft [goal]                   Create an editable markdown plan skeleton
  init [--force]                Scaffold .choirmaster/ in the current repo
  plan <plan.md|@query>         Decompose a markdown plan into a tasks file
  run <plan.md|@query|tasks.json>
                                Plan-then-run markdown, or run a tasks file
  run --resume <run-id>         Resume a paused or interrupted run
  completions <zsh|bash|fish|powershell|nushell>
                                Print shell completion script

Plan options:
  --output <path>               Write the generated tasks file here
  --force, -f                   Overwrite an existing tasks file at the output path

Draft options:
  --from <path>                 Create a draft from notes or an issue body
  --output <path>               Write the markdown plan here
  --force, -f                   Overwrite an existing markdown plan

Markdown shortcuts:
  @query                        Match markdown files in the repo, e.g. cm run @example

Completion protocol:
  __complete markdown <@query>  Print markdown suggestions for shell adapters

Doctor options:
  --cwd <path>                  Check a different project directory
  --skip-network, --offline     Skip DNS checks

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
    const argList = args.slice(1)
    const cwdIdx = argList.indexOf('--cwd')
    let cwd: string | undefined
    if (cwdIdx !== -1) {
      cwd = argList[cwdIdx + 1]
      if (!cwd) {
        process.stderr.write('--cwd requires a path.\n')
        return 64
      }
    }
    return doctorCommand({
      cwd,
      skipNetwork: argList.includes('--skip-network') || argList.includes('--offline'),
    })
  }

  if (command === 'draft') {
    const argList = args.slice(1)
    const consumed = new Set<number>()
    const fromIdx = argList.indexOf('--from')
    let fromFile: string | undefined
    if (fromIdx !== -1) {
      fromFile = argList[fromIdx + 1]
      if (!fromFile) {
        process.stderr.write('--from requires a path.\n')
        return 64
      }
      consumed.add(fromIdx)
      consumed.add(fromIdx + 1)
    }

    const outputIdx = argList.indexOf('--output')
    let outputFile: string | undefined
    if (outputIdx !== -1) {
      outputFile = argList[outputIdx + 1]
      if (!outputFile) {
        process.stderr.write('--output requires a path.\n')
        return 64
      }
      consumed.add(outputIdx)
      consumed.add(outputIdx + 1)
    }

    const goal = argList
      .filter((arg, i) => !consumed.has(i) && arg !== '--force' && arg !== '-f' && !arg.startsWith('-'))
      .join(' ')

    return draftCommand({
      goal,
      fromFile,
      outputFile,
      force: argList.includes('--force') || argList.includes('-f'),
    })
  }

  if (command === '__complete') {
    const kind = args[1]
    if (kind === 'markdown') {
      const input = args[2] ?? '@'
      for (const match of completeMarkdownReferences(input, process.cwd())) {
        process.stdout.write(`${match}\n`)
      }
      return 0
    }
    process.stderr.write('Usage: choirmaster __complete markdown <@query>\n')
    return 64
  }

  if (command === 'completions') {
    return completionsCommand({ shell: args[1] })
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

    const inputFile = argList.find((a, i) => !consumed.has(i) && !a.startsWith('-'))
    if (resumeRunId && inputFile) {
      process.stderr.write(
        `Pass either a plan/tasks file or --resume, not both. (got both '${inputFile}' and --resume ${resumeRunId})\n`,
      )
      return 64
    }
    if (!resumeRunId && !inputFile) {
      process.stderr.write(
        'Usage:\n'
        + '  choirmaster run <plan.md|@query|tasks.json> [--continue-on-blocked] [--reuse-worktree] [--no-auto-merge]\n'
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
    if (tasksFile?.startsWith('@')) {
      const planRef = resolveMarkdownReference(tasksFile, process.cwd())
      if (!planRef.ok) {
        process.stderr.write(formatMarkdownReferenceError(planRef))
        return 64
      }
      tasksFile = planRef.path
    }

    if (tasksFile && tasksFile.toLowerCase().endsWith('.md')) {
      const planExit = await planCommand({ planFile: tasksFile, force: true })
      if (planExit !== 0) return planExit
      tasksFile = tasksFile.replace(/\.md$/i, '.tasks.json')
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
