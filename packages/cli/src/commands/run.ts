/**
 * `choirmaster run <tasks.json>` or `choirmaster run --resume <run-id>`
 *
 * Fresh mode: loads tasks.json, creates a new per-run directory, drives
 * every pending task through the orchestration loop.
 *
 * Resume mode: loads an existing run's state.json and continues from
 * wherever it paused (capacity, blocked-but-still-fixable, killed
 * mid-run). The same orchestration loop handles both because runTask is
 * already phase-aware - the CLI just supplies the state instead of
 * minting it from a tasks file.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { RunState, Task } from '@choirmaster/core'
import { loadState, runTask, saveState, validateTasksFile } from '@choirmaster/core'

import { loadManifest } from '../manifest.js'
import { resolveProjectRoot } from '../project-root.js'

export interface RunCommandArgs {
  /** Path to tasks.json (relative or absolute). Required unless `resumeRunId`. */
  tasksFile?: string
  /** Existing run id to resume. When set, tasksFile is ignored. */
  resumeRunId?: string
  /** Working directory; defaults to process.cwd(). */
  cwd?: string
  /** Halt on the first task that ends `blocked`. Default: stop on first blocked. */
  continueOnBlocked?: boolean
  /** Allow reusing existing worktrees instead of refusing. */
  reuseWorktree?: boolean
  /** Skip the auto-merge step from the branch policy. */
  skipAutoMerge?: boolean
}

export async function runCommand(args: RunCommandArgs): Promise<number> {
  const projectRoot = resolveProjectRoot(args.cwd ?? process.cwd())

  let config
  try {
    config = await loadManifest(projectRoot)
  }
  catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }

  let runId: string
  let runDir: string
  let logsDir: string
  let state: RunState

  if (args.resumeRunId) {
    runId = args.resumeRunId
    runDir = resolve(projectRoot, '.choirmaster/runs', runId)
    if (!existsSync(runDir)) {
      process.stderr.write(`Run not found: .choirmaster/runs/${runId}\n`)
      return 1
    }
    try {
      state = loadState(runDir)
    }
    catch (err) {
      process.stderr.write(`Failed to load run state: ${(err as Error).message}\n`)
      return 1
    }
    logsDir = resolve(runDir, 'logs')
    mkdirSync(logsDir, { recursive: true })

    process.stdout.write(`\nChoirMaster resume ${runId}\n`)
    process.stdout.write(`  ${state.tasks.length} task(s) in run, plan source: ${state.plan_source}\n`)
    process.stdout.write(`  base branch: ${config.base}\n\n`)
  }
  else {
    if (!args.tasksFile) {
      process.stderr.write('Usage: choirmaster run <tasks.json> | --resume <run-id>\n')
      return 1
    }
    const tasksPath = resolve(projectRoot, args.tasksFile)
    if (!existsSync(tasksPath)) {
      process.stderr.write(`tasks file not found: ${tasksPath}\n`)
      return 1
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(tasksPath, 'utf8'))
    }
    catch (err) {
      process.stderr.write(`tasks file is not valid JSON: ${(err as Error).message}\n`)
      return 1
    }

    const validation = validateTasksFile(parsed)
    if (!validation.ok) {
      process.stderr.write(`Invalid tasks file (${args.tasksFile}):\n`)
      for (const e of validation.errors) {
        process.stderr.write(`  - ${e}\n`)
      }
      return 64
    }
    const tasks: Task[] = validation.tasks

    runId = makeRunId()
    runDir = resolve(projectRoot, '.choirmaster/runs', runId)
    logsDir = resolve(runDir, 'logs')
    mkdirSync(logsDir, { recursive: true })

    state = {
      id: runId,
      plan_source: args.tasksFile,
      started_at: new Date().toISOString(),
      current_task: null,
      tasks,
    }
    saveState(runDir, state)

    process.stdout.write(`\nChoirMaster run ${runId}\n`)
    process.stdout.write(`  ${tasks.length} task(s) loaded from ${args.tasksFile}\n`)
    process.stdout.write(`  base branch: ${config.base}\n`)
    process.stdout.write(`  state dir: .choirmaster/runs/${runId}\n\n`)
  }

  const tasks = state.tasks

  const ctx = { projectRoot, runDir, logsDir, config }

  let halted = false
  const blockedIds = new Set<string>()
  for (const task of tasks) {
    if (task.status === 'completed') continue

    // Skip tasks whose declared dependencies blocked. With
    // --continue-on-blocked the loop keeps running, but a task can't
    // meaningfully execute when its prereqs failed.
    if (task.depends_on) {
      const unmet = task.depends_on.filter((id) => blockedIds.has(id))
      if (unmet.length > 0) {
        task.status = 'blocked'
        task.blocked_reason = `Skipped: dependency blocked: ${unmet.join(', ')}`
        blockedIds.add(task.id)
        process.stdout.write(`\n=== ${task.id}: skipped (deps blocked: ${unmet.join(', ')}) ===\n`)
        saveState(runDir, state)
        continue
      }
    }

    process.stdout.write(`\n=== ${task.id}: ${task.title} ===\n`)
    await runTask(ctx, state, task, {
      allowReuseWorktree: args.reuseWorktree ?? false,
      skipAutoMerge: args.skipAutoMerge ?? false,
    })
    if (task.status === 'blocked') blockedIds.add(task.id)
    if (task.status === 'waiting_for_capacity') {
      halted = true
      break
    }
    if (task.status === 'blocked' && !args.continueOnBlocked) {
      halted = true
      break
    }
  }

  printSummary(state, halted)
  state.current_task = null
  saveState(runDir, state)

  // Non-zero exit on any non-success state. CI needs to see capacity
  // pauses as failures even though they're recoverable.
  const blocked = state.tasks.filter((t) => t.status === 'blocked').length
  const waiting = state.tasks.filter((t) => t.status === 'waiting_for_capacity').length
  if (blocked > 0) return 2
  if (waiting > 0) return 3
  return 0
}

function makeRunId(): string {
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${now}-${rand}`
}

function printSummary(state: RunState, halted: boolean): void {
  const counts: Record<string, number> = {
    completed: 0, blocked: 0, waiting_for_capacity: 0, pending: 0, in_progress: 0,
  }
  for (const t of state.tasks) counts[t.status] = (counts[t.status] ?? 0) + 1

  process.stdout.write(`\nRun summary: ${counts.completed} completed, ${counts.blocked} blocked, ${counts.waiting_for_capacity} waiting, ${counts.pending} pending`)
  if (counts.in_progress) process.stdout.write(`, ${counts.in_progress} in_progress`)
  process.stdout.write('\n')
  if (halted) process.stdout.write(`(loop halted on first non-completing task)\n`)

  const blocked = state.tasks.filter((t) => t.status === 'blocked')
  if (blocked.length > 0) {
    process.stdout.write('\nBlocked tasks (inspect logs in .choirmaster/runs/<id>/logs/):\n')
    for (const t of blocked) {
      const reason = (t.blocked_reason || '(no reason recorded)').split('\n')[0]
      process.stdout.write(`  ${t.id}: ${reason}\n`)
    }
  }

  const waiting = state.tasks.filter((t) => t.status === 'waiting_for_capacity')
  if (waiting.length > 0) {
    process.stdout.write('\nWaiting for capacity (re-run after the cap window resets):\n')
    for (const t of waiting) {
      process.stdout.write(`  ${t.id}: phase=${t.paused_phase ?? '?'}\n`)
    }
  }

  const completed = state.tasks.filter((t) => t.status === 'completed')
  if (completed.length > 0) {
    process.stdout.write('\nCompleted:\n')
    for (const t of completed) {
      const sha = t.commit ? t.commit.slice(0, 8) : '?'
      process.stdout.write(`  ${t.id}: ${sha} on ${t.branch}\n`)
    }
  }
}
