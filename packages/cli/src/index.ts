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
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { completionsCommand } from './commands/completions.js'
import { doctorCommand } from './commands/doctor.js'
import { draftCommand } from './commands/draft.js'
import { initCommand } from './commands/init.js'
import { defaultTasksOutputPath, planCommand } from './commands/plan.js'
import { runCommand } from './commands/run.js'
import { completeMarkdownReferences, formatMarkdownReferenceError, resolveMarkdownReference } from './markdown-ref.js'
import { pickMarkdownFile } from './markdown-picker.js'
import { resolveProjectRoot } from './project-root.js'

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
  draft [goal...]                Create an editable markdown plan
  init [--force | -f]           Scaffold .choirmaster/ in the current repo
  plan [plan.md|@query]         Decompose a markdown plan into a task contract
  run [plan.md|@query]          Plan-then-run markdown
  run --resume <run-id>         Resume a paused or interrupted run
  completions <zsh|bash|fish|powershell|nushell>
                                Print shell completion script

Plan options:
  --output <path>               Write the generated task contract here
  --force, -f                   Overwrite an existing task contract at the output path

Draft options:
  --from <path>                 Create a draft from notes or an issue body
  --output <path>               Write the markdown plan here (any writable path)
  --interactive, --ask          Ask concise questions before writing the plan
  --force, -f                   Overwrite an existing markdown plan

Markdown shortcuts:
  @query                        Exact markdown reference; completions provide fuzzy suggestions
  no input                      Open ChoirMaster's interactive markdown picker

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
    const cwd = readFlagValue(argList, '--cwd')
    if (!cwd.ok) {
      process.stderr.write(cwd.error)
      return 64
    }
    return doctorCommand({
      cwd: cwd.value,
      skipNetwork: argList.includes('--skip-network') || argList.includes('--offline'),
    })
  }

  if (command === 'draft') {
    const argList = args.slice(1)
    const consumed = new Set<number>()
    const fromFile = readFlagValue(argList, '--from')
    if (!fromFile.ok) {
      process.stderr.write(fromFile.error)
      return 64
    }
    markConsumed(consumed, fromFile)

    const outputFile = readFlagValue(argList, '--output')
    if (!outputFile.ok) {
      process.stderr.write(outputFile.error)
      return 64
    }
    markConsumed(consumed, outputFile)

    const goal = collectDraftGoal(argList, consumed)

    return draftCommand({
      goal,
      fromFile: fromFile.value,
      outputFile: outputFile.value,
      interactive: argList.includes('--interactive') || argList.includes('--ask'),
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
    const consumed = new Set<number>()
    const outputFile = readFlagValue(argList, '--output')
    if (!outputFile.ok) {
      process.stderr.write(outputFile.error)
      return 64
    }
    markConsumed(consumed, outputFile)
    // Skip anything that looks like an option (starts with `-`), not just
    // double-dash long flags. Otherwise `choirmaster plan -f plan.md`
    // would pick `-f` as the positional plan file and fail before the
    // real path is read.
    const selected = await resolveMarkdownInput(findPositionalArg(argList, consumed), 'plan')
    if (!selected.ok) return selected.code

    return planCommand({
      planFile: selected.path,
      outputFile: outputFile.value,
      force: args.includes('--force') || args.includes('-f'),
    })
  }

  if (command === 'run') {
    const argList = args.slice(1)

    // --resume <run-id> takes precedence over a positional input.
    const consumed = new Set<number>()
    const resumeRunId = readFlagValue(argList, '--resume')
    if (!resumeRunId.ok) {
      process.stderr.write(resumeRunId.error)
      return 64
    }
    markConsumed(consumed, resumeRunId)

    const inputFile = findPositionalArg(argList, consumed)
    if (resumeRunId.value && inputFile) {
      process.stderr.write(
        `Pass either a plan file or --resume, not both. (got both '${inputFile}' and --resume ${resumeRunId.value})\n`,
      )
      return 64
    }
    if (resumeRunId.value) {
      return runCommand({
        resumeRunId: resumeRunId.value,
        continueOnBlocked: args.includes('--continue-on-blocked'),
        reuseWorktree: args.includes('--reuse-worktree'),
        skipAutoMerge: args.includes('--no-auto-merge'),
      })
    }
    if (!resumeRunId.value && !inputFile) {
      const selected = await resolveMarkdownInput(undefined, 'run')
      if (!selected.ok) return selected.code
      return runMarkdownInput(selected, {
        continueOnBlocked: args.includes('--continue-on-blocked'),
        reuseWorktree: args.includes('--reuse-worktree'),
        skipAutoMerge: args.includes('--no-auto-merge'),
      })
    }

    // Plan-then-run: when the input is a markdown file, run the planner
    // first, then dispatch the generated task contract. Keeps the
    // user-facing shape simple (`run <plan.md>`). Direct task-contract
    // execution still works for internal/advanced workflows, but it is no
    // longer advertised as the normal surface. Plan-then-run forces overwrite
    // on the generated file because fresh planning is the explicit intent
    // of this entry point; standalone `choirmaster plan` defaults to
    // refusing overwrites so reviewed/edited tasks files don't get
    // clobbered by a re-plan.
    const selected = await resolveMarkdownInput(inputFile, 'run')
    if (!selected.ok) return selected.code

    return runMarkdownInput(selected, {
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

type MarkdownInputResult =
  | { ok: true; path: string; runReference?: string }
  | { ok: false; code: number }

async function resolveMarkdownInput(input: string | undefined, action: 'plan' | 'run'): Promise<MarkdownInputResult> {
  if (!input) {
    const picked = await pickMarkdownFile({
      cwd: process.cwd(),
      title: action === 'run' ? 'Select a markdown file to run' : 'Select a markdown file to plan',
    })
    if (!picked.ok) {
      process.stderr.write(`${picked.message}\n`)
      return { ok: false, code: picked.code }
    }
    return { ok: true, path: picked.path }
  }

  if (!input.startsWith('@')) {
    return { ok: true, path: input }
  }

  const planRef = resolveMarkdownReference(input, process.cwd())
  if (planRef.ok) {
    return { ok: true, path: planRef.path, runReference: input }
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const picked = await pickMarkdownFile({
      cwd: process.cwd(),
      initialQuery: input.slice(1),
      title: action === 'run' ? 'Select a markdown file to run' : 'Select a markdown file to plan',
    })
    if (!picked.ok) {
      process.stderr.write(`${picked.message}\n`)
      return { ok: false, code: picked.code }
    }
    return { ok: true, path: picked.path }
  }

  process.stderr.write(formatMarkdownReferenceError(planRef))
  return { ok: false, code: 64 }
}

async function runMarkdownInput(
  selected: Extract<MarkdownInputResult, { ok: true }>,
  options: {
    continueOnBlocked: boolean
    reuseWorktree: boolean
    skipAutoMerge: boolean
  },
): Promise<number> {
  let tasksFile = selected.path

  if (tasksFile.toLowerCase().endsWith('.md')) {
    const planExit = await planCommand({ planFile: selected.runReference ?? tasksFile, force: true })
    if (planExit !== 0) return planExit
    const projectRoot = resolveProjectRoot(process.cwd())
    tasksFile = relative(
      projectRoot,
      defaultTasksOutputPath(resolve(projectRoot, tasksFile), projectRoot),
    )
  }

  return runCommand({
    tasksFile,
    continueOnBlocked: options.continueOnBlocked,
    reuseWorktree: options.reuseWorktree,
    skipAutoMerge: options.skipAutoMerge,
  })
}

type FlagValue =
  | { ok: true; value: string | undefined; indexes: number[] }
  | { ok: false; error: string }

function readFlagValue(args: string[], flag: string): FlagValue {
  const endOfOptions = args.indexOf('--')
  const index = args.findIndex((arg, i) => arg === flag && (endOfOptions === -1 || i < endOfOptions))
  if (index === -1) return { ok: true, value: undefined, indexes: [] }
  const value = args[index + 1]
  if (!value || value.startsWith('-')) {
    return { ok: false, error: `${flag} requires a value.\n` }
  }
  return { ok: true, value, indexes: [index, index + 1] }
}

function markConsumed(consumed: Set<number>, value: FlagValue): void {
  if (!value.ok) return
  for (const index of value.indexes) {
    consumed.add(index)
  }
}

function collectDraftGoal(args: string[], consumed: Set<number>): string {
  const endOfOptions = args.indexOf('--')
  if (endOfOptions !== -1) {
    return args
      .slice(endOfOptions + 1)
      .join(' ')
  }
  return args
    .filter((arg, i) => !consumed.has(i) && !arg.startsWith('-'))
    .join(' ')
}

function findPositionalArg(args: string[], consumed: Set<number>): string | undefined {
  const endOfOptions = args.indexOf('--')
  if (endOfOptions !== -1) {
    return args.slice(endOfOptions + 1).find(Boolean)
  }
  return args.find((arg, i) => !consumed.has(i) && !arg.startsWith('-'))
}
