/**
 * Tests for `validateTasksFile`. Covers the failure modes a hand-edited
 * tasks file is most likely to hit: missing fields, wrong types, duplicate
 * ids and worktrees, broken dependencies, cycles, and bad limits.
 */

import { describe, expect, it } from 'vitest'

import { validateTasksFile } from './tasks-file.js'

// Minimal valid task. Tests clone this and override one or more fields.
const validTask = {
  id: 'TASK-01',
  title: 'something',
  branch: 'task/01',
  worktree: '.choirmaster/wt/01',
  allowed_paths: ['app/**'],
  definition_of_done: ['file exists'],
}

function ok<T extends { ok: true }>(v: T | { ok: false, errors: string[] }): T {
  if (!v.ok) throw new Error(`expected ok, got errors:\n  ${v.errors.join('\n  ')}`)
  return v
}

function bad(v: ReturnType<typeof validateTasksFile>): string[] {
  if (v.ok) throw new Error('expected validation to fail')
  return v.errors
}

describe('validateTasksFile', () => {
  it('accepts a minimal valid task list (array form)', () => {
    const result = ok(validateTasksFile([validTask]))
    expect(result.tasks).toHaveLength(1)
    expect(result.tasks[0]?.id).toBe('TASK-01')
    // Defaults applied for runtime fields.
    expect(result.tasks[0]?.attempts).toBe(0)
    expect(result.tasks[0]?.review_iterations).toBe(0)
    expect(result.tasks[0]?.status).toBe('pending')
    expect(result.tasks[0]?.forbidden_paths).toEqual([])
    expect(result.tasks[0]?.gates).toEqual([])
  })

  it('accepts the {tasks: [...]} object form', () => {
    const result = ok(validateTasksFile({ tasks: [validTask] }))
    expect(result.tasks).toHaveLength(1)
  })

  it('rejects a non-array, non-{tasks: []} top level', () => {
    const errors = bad(validateTasksFile({ foo: 'bar' }))
    expect(errors[0]).toMatch(/must be a JSON array/)
  })

  it('rejects an empty task list', () => {
    expect(bad(validateTasksFile([]))).toContain('tasks file contains no tasks')
  })

  it('flags every missing required field on a single task', () => {
    const errors = bad(validateTasksFile([{}]))
    // All six required scalars + the two required arrays should fire.
    expect(errors.some((e) => e.includes('tasks[0].id'))).toBe(true)
    expect(errors.some((e) => e.includes('tasks[0].title'))).toBe(true)
    expect(errors.some((e) => e.includes('tasks[0].branch'))).toBe(true)
    expect(errors.some((e) => e.includes('tasks[0].worktree'))).toBe(true)
    expect(errors.some((e) => e.includes('tasks[0].allowed_paths'))).toBe(true)
    expect(errors.some((e) => e.includes('tasks[0].definition_of_done'))).toBe(true)
  })

  it('rejects an empty allowed_paths', () => {
    const errors = bad(validateTasksFile([{ ...validTask, allowed_paths: [] }]))
    expect(errors.some((e) => e.includes('allowed_paths') && e.includes('at least one'))).toBe(true)
  })

  it('rejects an empty definition_of_done', () => {
    const errors = bad(validateTasksFile([{ ...validTask, definition_of_done: [] }]))
    expect(errors.some((e) => e.includes('definition_of_done') && e.includes('at least one'))).toBe(true)
  })

  it('rejects non-string entries in path arrays', () => {
    const errors = bad(validateTasksFile([{ ...validTask, allowed_paths: ['app/**', 42] }]))
    expect(errors.some((e) => e.includes('allowed_paths[1]'))).toBe(true)
  })

  it('rejects gates that are not {name, command} objects', () => {
    const errors = bad(validateTasksFile([{
      ...validTask,
      gates: [
        { name: '', command: 'echo' },
        { name: 'typecheck', command: '   ' },
        { name: 'test' }, // missing command
        'oops', // not even an object
      ],
    }]))
    expect(errors.some((e) => e.includes('gates[0].name'))).toBe(true)
    expect(errors.some((e) => e.includes('gates[1].command'))).toBe(true)
    expect(errors.some((e) => e.includes('gates[2].command'))).toBe(true)
    expect(errors.some((e) => e.includes('gates[3]'))).toBe(true)
  })

  it('flags duplicate ids', () => {
    const errors = bad(validateTasksFile([
      { ...validTask, id: 'TASK-01', worktree: '.choirmaster/wt/a' },
      { ...validTask, id: 'TASK-01', worktree: '.choirmaster/wt/b' },
    ]))
    expect(errors.some((e) => e.includes('duplicate id'))).toBe(true)
  })

  it('flags duplicate worktree paths', () => {
    const errors = bad(validateTasksFile([
      { ...validTask, id: 'TASK-A', branch: 'task/a', worktree: '.choirmaster/wt/shared' },
      { ...validTask, id: 'TASK-B', branch: 'task/b', worktree: '.choirmaster/wt/shared' },
    ]))
    expect(errors.some((e) => e.includes('duplicate worktree'))).toBe(true)
  })

  it('flags duplicate branch values', () => {
    // Two tasks pointing at the same branch would later collide in
    // `git worktree add -b` mid-run; reject up-front.
    const errors = bad(validateTasksFile([
      { ...validTask, id: 'TASK-A', branch: 'task/shared', worktree: '.choirmaster/wt/a' },
      { ...validTask, id: 'TASK-B', branch: 'task/shared', worktree: '.choirmaster/wt/b' },
    ]))
    expect(errors.some((e) => e.includes('duplicate branch') && e.includes('task/shared'))).toBe(true)
  })

  it('rejects an absolute worktree path', () => {
    const errors = bad(validateTasksFile([
      { ...validTask, worktree: '/tmp/escape' },
    ]))
    expect(errors.some((e) => e.includes('worktree') && e.includes('relative'))).toBe(true)
  })

  it('rejects a worktree path that traverses above the project root', () => {
    const errors = bad(validateTasksFile([
      { ...validTask, worktree: '../outside' },
    ]))
    expect(errors.some((e) => e.includes('worktree') && e.includes("'..'"))).toBe(true)
  })

  it('rejects a worktree path with deeper escape sequences', () => {
    const errors = bad(validateTasksFile([
      { ...validTask, worktree: '.choirmaster/wt/../../../escape' },
    ]))
    expect(errors.some((e) => e.includes('worktree') && e.includes("'..'"))).toBe(true)
  })

  it("rejects '..' segments even when they normalize back to a safe path", () => {
    // `a/../b` would resolve to the same directory as `b`. If we let
    // the literal `a/../b` through, two tasks could index distinct
    // worktree strings that collide on disk - exactly what the
    // duplicate-worktree check is meant to prevent. Refusing any `..`
    // segment keeps the indexed string equal to the on-disk path.
    const errors = bad(validateTasksFile([
      { ...validTask, worktree: 'a/../b' },
    ]))
    expect(errors.some((e) => e.includes('worktree') && e.includes("'..'"))).toBe(true)
  })

  it("rejects '.' segments (same on-disk-collision rationale as '..')", () => {
    // `./b` and `b` resolve to the same directory. Same hole as `..`,
    // smaller blast radius - a task file could still pass validation
    // with two worktrees that collide at sandbox.setup. Reject `.`
    // outright so the indexed string equals the on-disk path.
    const errors = bad(validateTasksFile([
      { ...validTask, worktree: './b' },
    ]))
    expect(errors.some((e) => e.includes('worktree') && e.includes("'.'"))).toBe(true)
  })

  it("rejects '.' segments in the middle of a worktree path", () => {
    const errors = bad(validateTasksFile([
      { ...validTask, worktree: '.choirmaster/./wt/01' },
    ]))
    expect(errors.some((e) => e.includes('worktree') && e.includes("'.'"))).toBe(true)
  })

  it("rejects two worktree paths that resolve to the same directory after normalization", () => {
    // The strict `.` and `..` rules above mean both tasks fail
    // validation; this test pins that no two paths in the list survive
    // to silently collide on disk. Without strict rejection (or path
    // normalization at index time), the second task would slip through
    // validation and crash mid-run in `git worktree add`.
    const errors = bad(validateTasksFile([
      { ...validTask, id: 'TASK-A', branch: 'task/a', worktree: '.choirmaster/wt/a' },
      { ...validTask, id: 'TASK-B', branch: 'task/b', worktree: '.choirmaster/wt/x/../a' },
    ]))
    expect(errors.some((e) => e.includes("'..'"))).toBe(true)
  })

  it("does not flag directory names that happen to start with '.'", () => {
    // `.choirmaster` is a directory whose name starts with a dot. It is
    // not a `.` path segment, so it must continue to validate.
    const result = ok(validateTasksFile([
      { ...validTask, worktree: '.choirmaster/wt/legitimate' },
    ]))
    expect(result.tasks).toHaveLength(1)
  })

  it('rejects a Windows drive-rooted worktree path', () => {
    const errors = bad(validateTasksFile([
      { ...validTask, worktree: 'C:/escape' },
    ]))
    expect(errors.some((e) => e.includes('worktree') && e.includes('relative'))).toBe(true)
  })

  it('flags depends_on referencing an unknown task', () => {
    const errors = bad(validateTasksFile([
      { ...validTask, id: 'TASK-01', depends_on: ['TASK-99'] },
    ]))
    expect(errors.some((e) => e.includes('unknown task') && e.includes('TASK-99'))).toBe(true)
  })

  it('flags a task that depends on itself', () => {
    const errors = bad(validateTasksFile([
      { ...validTask, id: 'TASK-01', depends_on: ['TASK-01'] },
    ]))
    expect(errors.some((e) => e.includes('cannot reference itself'))).toBe(true)
  })

  it('flags dependency cycles with the cycle path', () => {
    const errors = bad(validateTasksFile([
      { ...validTask, id: 'A', branch: 'task/a', worktree: '.choirmaster/wt/a', depends_on: ['B'] },
      { ...validTask, id: 'B', branch: 'task/b', worktree: '.choirmaster/wt/b', depends_on: ['C'] },
      { ...validTask, id: 'C', branch: 'task/c', worktree: '.choirmaster/wt/c', depends_on: ['A'] },
    ]))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/cycle/)
    // Cycle path includes all three ids.
    expect(errors[0]).toContain('A')
    expect(errors[0]).toContain('B')
    expect(errors[0]).toContain('C')
  })

  it('topologically sorts on success (deps before dependents)', () => {
    const result = ok(validateTasksFile([
      { ...validTask, id: 'C', branch: 'task/c', worktree: '.choirmaster/wt/c', depends_on: ['B'] },
      { ...validTask, id: 'A', branch: 'task/a', worktree: '.choirmaster/wt/a' },
      { ...validTask, id: 'B', branch: 'task/b', worktree: '.choirmaster/wt/b', depends_on: ['A'] },
    ]))
    const ids = result.tasks.map((t) => t.id)
    expect(ids.indexOf('A')).toBeLessThan(ids.indexOf('B'))
    expect(ids.indexOf('B')).toBeLessThan(ids.indexOf('C'))
  })

  it('rejects max_attempts that is not a positive integer', () => {
    expect(bad(validateTasksFile([{ ...validTask, max_attempts: 0 }]))[0])
      .toMatch(/max_attempts must be a positive integer/)
    expect(bad(validateTasksFile([{ ...validTask, max_attempts: -1 }]))[0])
      .toMatch(/max_attempts must be a positive integer/)
    expect(bad(validateTasksFile([{ ...validTask, max_attempts: 1.5 }]))[0])
      .toMatch(/max_attempts must be a positive integer/)
    expect(bad(validateTasksFile([{ ...validTask, max_attempts: 'three' }]))[0])
      .toMatch(/max_attempts must be a positive integer/)
  })

  it('rejects max_review_iterations that is not a positive integer', () => {
    expect(bad(validateTasksFile([{ ...validTask, max_review_iterations: 0 }]))[0])
      .toMatch(/max_review_iterations must be a positive integer/)
  })

  it('accepts valid limits', () => {
    const result = ok(validateTasksFile([{
      ...validTask,
      max_attempts: 5,
      max_review_iterations: 4,
    }]))
    expect(result.tasks[0]?.max_attempts).toBe(5)
    expect(result.tasks[0]?.max_review_iterations).toBe(4)
  })

  it('reports problems from multiple tasks together', () => {
    const errors = bad(validateTasksFile([
      { ...validTask, id: 'TASK-01' },
      { id: 'TASK-02' }, // missing almost everything
      { ...validTask, id: 'TASK-01', worktree: '.choirmaster/wt/dup' }, // duplicate id
    ]))
    expect(errors.some((e) => e.includes('tasks[1].title'))).toBe(true)
    expect(errors.some((e) => e.includes('duplicate id'))).toBe(true)
  })
})
