/**
 * Validate a parsed `*.tasks.json` payload before the runtime executes
 * any task. The CLI calls this immediately after `JSON.parse` so users
 * see every problem in one shot rather than discovering them mid-run.
 *
 * What this validator does, and why:
 *
 *  1. Per-task shape: every required field is present and the right type.
 *     Without this check a typo (e.g. `"allowed_path"`) would only surface
 *     during the agent's first turn, after a worktree has been created and
 *     the agent has been invoked - waste of capacity and confusing logs.
 *
 *  2. Cross-task uniqueness: ids must be unique, worktree paths must be
 *     unique. Duplicate ids cause silent dependency confusion downstream;
 *     duplicate worktrees cause two tasks to clobber each other on disk.
 *
 *  3. Dependency integrity: every `depends_on` id must reference a
 *     declared task, no task may depend on itself, and the dependency
 *     graph must be acyclic. Cycles deadlock the runner.
 *
 *  4. Limit sanity: per-task `max_attempts` and `max_review_iterations`
 *     must be positive integers. A zero or negative value would block the
 *     task on its first turn with a confusing "max exhausted" message.
 *
 * Errors are accumulated, not thrown one at a time, so a malformed file
 * with five problems surfaces all five in a single CLI run.
 *
 * On success the validator returns the task list in topological order
 * (depends_on before dependents) so the CLI can iterate it directly.
 */

import type { GateConfig, Task } from '../types.js'

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export type TasksFileValidationResult =
  | { ok: true, tasks: Task[] }
  | { ok: false, errors: string[] }

/**
 * Validate the parsed JSON payload of a `*.tasks.json` file. Returns
 * either a topologically-sorted Task[] or a list of human-readable
 * error strings (every problem found, not just the first).
 */
export function validateTasksFile(parsed: unknown): TasksFileValidationResult {
  const errors: string[] = []

  const rawTasks = extractTaskArray(parsed, errors)
  if (!rawTasks) return { ok: false, errors }

  if (rawTasks.length === 0) {
    return { ok: false, errors: ['tasks file contains no tasks'] }
  }

  const tasks: Task[] = []
  const idIndex = new Map<string, number>()
  const worktreeIndex = new Map<string, number>()

  for (let i = 0; i < rawTasks.length; i++) {
    const path = `tasks[${i}]`
    const before = errors.length
    const t = parseTask(rawTasks[i], path, errors)
    if (errors.length > before || !t) continue

    const idDup = idIndex.get(t.id)
    if (idDup !== undefined) {
      errors.push(`${path}: duplicate id '${t.id}' (already used by tasks[${idDup}])`)
      continue
    }
    const wtDup = worktreeIndex.get(t.worktree)
    if (wtDup !== undefined) {
      errors.push(`${path}: duplicate worktree path '${t.worktree}' (already used by tasks[${wtDup}])`)
      continue
    }

    idIndex.set(t.id, i)
    worktreeIndex.set(t.worktree, i)
    tasks.push(t)
  }

  // depends_on integrity. Run this only against tasks that survived
  // per-field validation; otherwise we'd report misleading "unknown dep"
  // errors for tasks that were actually rejected for other reasons.
  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (dep === t.id) {
        errors.push(`task ${t.id}: depends_on cannot reference itself`)
        continue
      }
      if (!idIndex.has(dep)) {
        errors.push(`task ${t.id}: depends_on references unknown task '${dep}'`)
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  // Topological sort. Returns the cycle path on failure for a clearer
  // diagnostic than "involves X".
  const sortResult = topoSort(tasks)
  if (!sortResult.ok) {
    return { ok: false, errors: [`dependency cycle detected: ${sortResult.cycle.join(' -> ')}`] }
  }
  return { ok: true, tasks: sortResult.sorted }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-task parsing
// ─────────────────────────────────────────────────────────────────────────────

function extractTaskArray(parsed: unknown, errors: string[]): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (isObject(parsed) && Array.isArray(parsed.tasks)) return parsed.tasks
  errors.push('tasks file must be a JSON array, or an object with a "tasks" array')
  return null
}

function parseTask(raw: unknown, path: string, errors: string[]): Task | null {
  if (!isObject(raw)) {
    errors.push(`${path}: must be a JSON object`)
    return null
  }

  const id = requireNonEmptyString(raw, 'id', path, errors)
  const title = requireNonEmptyString(raw, 'title', path, errors)
  const branch = requireNonEmptyString(raw, 'branch', path, errors)
  const worktree = requireNonEmptyString(raw, 'worktree', path, errors)

  const allowed_paths = requireStringArray(raw, 'allowed_paths', path, errors, { allowEmpty: false })
  const forbidden_paths = optionalStringArray(raw, 'forbidden_paths', path, errors) ?? []
  const definition_of_done = requireStringArray(raw, 'definition_of_done', path, errors, { allowEmpty: false })

  const gates = parseGates(raw, path, errors)
  const depends_on = optionalStringArray(raw, 'depends_on', path, errors)

  const max_attempts = optionalPositiveInt(raw, 'max_attempts', path, errors)
  const max_review_iterations = optionalPositiveInt(raw, 'max_review_iterations', path, errors)

  // Optional descriptive fields.
  const description = optionalString(raw, 'description')
  const spec_section = optionalString(raw, 'spec_section')

  // Bail if any required field failed; an incomplete Task object is
  // worse than no task at all because later checks (duplicate ids,
  // depends_on integrity) would emit follow-on noise.
  if (id === null || title === null || branch === null || worktree === null
    || allowed_paths === null || definition_of_done === null) {
    return null
  }

  return {
    id,
    title,
    description,
    spec_section,
    branch,
    worktree,
    allowed_paths,
    forbidden_paths,
    gates,
    definition_of_done,
    depends_on,
    max_attempts,
    max_review_iterations,
    attempts: 0,
    review_iterations: 0,
    status: 'pending',
  }
}

function parseGates(
  raw: Record<string, unknown>,
  path: string,
  errors: string[],
): GateConfig[] {
  const value = raw.gates
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    errors.push(`${path}.gates must be an array of {name, command} objects`)
    return []
  }
  const out: GateConfig[] = []
  for (let i = 0; i < value.length; i++) {
    const gpath = `${path}.gates[${i}]`
    const g = value[i]
    if (!isObject(g)) {
      errors.push(`${gpath}: must be a JSON object`)
      continue
    }
    if (typeof g.name !== 'string' || g.name.trim() === '') {
      errors.push(`${gpath}.name must be a non-empty string`)
      continue
    }
    if (typeof g.command !== 'string' || g.command.trim() === '') {
      errors.push(`${gpath}.command must be a non-empty string`)
      continue
    }
    out.push({
      name: g.name,
      command: g.command,
      description: typeof g.description === 'string' ? g.description : undefined,
    })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Field helpers
// ─────────────────────────────────────────────────────────────────────────────

function requireNonEmptyString(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): string | null {
  const v = raw[key]
  if (typeof v !== 'string' || v.trim() === '') {
    errors.push(`${path}.${key} must be a non-empty string`)
    return null
  }
  return v
}

function optionalString(raw: Record<string, unknown>, key: string): string | undefined {
  const v = raw[key]
  return typeof v === 'string' ? v : undefined
}

function requireStringArray(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
  options: { allowEmpty: boolean },
): string[] | null {
  const v = raw[key]
  if (!Array.isArray(v)) {
    errors.push(`${path}.${key} must be an array of strings`)
    return null
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string' || (v[i] as string).trim() === '') {
      errors.push(`${path}.${key}[${i}] must be a non-empty string`)
      return null
    }
  }
  if (!options.allowEmpty && v.length === 0) {
    errors.push(`${path}.${key} must contain at least one entry`)
    return null
  }
  return v as string[]
}

function optionalStringArray(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): string[] | undefined {
  const v = raw[key]
  if (v === undefined) return undefined
  if (!Array.isArray(v)) {
    errors.push(`${path}.${key} must be an array of strings`)
    return undefined
  }
  for (let i = 0; i < v.length; i++) {
    if (typeof v[i] !== 'string') {
      errors.push(`${path}.${key}[${i}] must be a string`)
      return undefined
    }
  }
  return v as string[]
}

function optionalPositiveInt(
  raw: Record<string, unknown>,
  key: string,
  path: string,
  errors: string[],
): number | undefined {
  const v = raw[key]
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    errors.push(`${path}.${key} must be a positive integer`)
    return undefined
  }
  return v
}

// ─────────────────────────────────────────────────────────────────────────────
// Topological sort
// ─────────────────────────────────────────────────────────────────────────────

interface TopoOk { ok: true, sorted: Task[] }
interface TopoCycle { ok: false, cycle: string[] }

function topoSort(tasks: Task[]): TopoOk | TopoCycle {
  const byId = new Map<string, Task>()
  for (const t of tasks) byId.set(t.id, t)

  const visited = new Set<string>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sorted: Task[] = []

  const visit = (task: Task): TopoCycle | null => {
    if (visited.has(task.id)) return null
    if (onStack.has(task.id)) {
      const idx = stack.indexOf(task.id)
      const path = stack.slice(idx).concat(task.id)
      return { ok: false, cycle: path }
    }
    onStack.add(task.id)
    stack.push(task.id)
    for (const dep of task.depends_on ?? []) {
      const depTask = byId.get(dep)
      if (!depTask) continue
      const result = visit(depTask)
      if (result) return result
    }
    onStack.delete(task.id)
    stack.pop()
    visited.add(task.id)
    sorted.push(task)
    return null
  }

  for (const task of tasks) {
    const result = visit(task)
    if (result) return result
  }
  return { ok: true, sorted }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
