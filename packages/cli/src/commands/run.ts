/**
 * `choirmaster run <tasks.json>`
 *
 * Loads the project manifest and a tasks.json file, sets up a per-run
 * directory, and drives every pending task through the orchestration
 * loop. After the run, prints a per-task breakdown of statuses.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { RunState, Task } from '@choirmaster/core'
import { runTask, saveState } from '@choirmaster/core'

import { loadManifest } from '../manifest.js'

export interface RunCommandArgs {
  /** Path to tasks.json (relative or absolute). */
  tasksFile: string
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
  const projectRoot = resolve(args.cwd ?? process.cwd())
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

  const rawTasks = extractTasks(parsed)
  if (rawTasks.length === 0) {
    process.stderr.write('tasks file contains no tasks.\n')
    return 1
  }

  let tasks: Task[]
  try {
    tasks = topologicallySort(rawTasks)
  }
  catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }

  let config
  try {
    config = await loadManifest(projectRoot)
  }
  catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }

  // Run id includes milliseconds + a 4-char random suffix so two runs in
  // the same second don't collide (race-prone with short tasks).
  const runId = makeRunId()
  const runDir = resolve(projectRoot, '.choirmaster/runs', runId)
  const logsDir = resolve(runDir, 'logs')
  mkdirSync(logsDir, { recursive: true })

  const state: RunState = {
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

/**
 * Topologically sort tasks by `depends_on`. Throws on cycles or unknown
 * dependency ids. Stable order: tasks with no deps preserve their input
 * order; dependents follow their last prerequisite.
 */
function topologicallySort(tasks: Task[]): Task[] {
  const byId = new Map<string, Task>()
  for (const t of tasks) byId.set(t.id, t)

  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`Task ${t.id} depends_on ${dep}, but no such task exists in tasks.json.`)
      }
    }
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  const sorted: Task[] = []

  const visit = (task: Task): void => {
    if (visited.has(task.id)) return
    if (visiting.has(task.id)) {
      throw new Error(`Dependency cycle detected involving ${task.id}.`)
    }
    visiting.add(task.id)
    for (const dep of task.depends_on ?? []) {
      const depTask = byId.get(dep)
      if (depTask) visit(depTask)
    }
    visiting.delete(task.id)
    visited.add(task.id)
    sorted.push(task)
  }

  for (const task of tasks) visit(task)
  return sorted
}

function makeRunId(): string {
  const now = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
  const rand = Math.random().toString(36).slice(2, 6)
  return `${now}-${rand}`
}

function extractTasks(parsed: unknown): Task[] {
  if (Array.isArray(parsed)) {
    return parsed as Task[]
  }
  if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { tasks?: unknown }).tasks)) {
    return (parsed as { tasks: Task[] }).tasks
  }
  throw new Error('tasks file must be a JSON array or an object with a "tasks" array.')
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
