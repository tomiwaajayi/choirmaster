/**
 * Per-run state I/O. The state file is the source of truth for everything
 * resumable: task statuses, retry counters, paused phase, last review issues.
 * It mutates on every state transition; concurrent runs against the same
 * file are not supported.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import type { RunState } from '../types.js'
import { ensureParent } from './log.js'

export function stateFilePath(runDir: string): string {
  return join(runDir, 'state.json')
}

export function loadState(runDir: string): RunState {
  const file = stateFilePath(runDir)
  if (!existsSync(file)) {
    throw new Error(`No state file at ${file}. Initialise the run first.`)
  }
  return JSON.parse(readFileSync(file, 'utf8')) as RunState
}

export function saveState(runDir: string, state: RunState): void {
  const file = stateFilePath(runDir)
  ensureParent(file)
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Initialise a fresh state file. Caller is responsible for not clobbering an
 * existing run; pass `force` to overwrite.
 */
export function initState(
  runDir: string,
  state: RunState,
  options: { force?: boolean } = {},
): void {
  const file = stateFilePath(runDir)
  if (existsSync(file) && !options.force) {
    throw new Error(`State file already exists at ${file}. Pass force to overwrite.`)
  }
  saveState(runDir, state)
}

/** Convenience: find a task by id. Throws on miss. */
export function getTask(state: RunState, id: string): RunState['tasks'][number] {
  const task = state.tasks.find((t) => t.id === id)
  if (!task) throw new Error(`Unknown task: ${id}`)
  return task
}
