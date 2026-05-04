/**
 * Focused tests for `printSummary`. Full runtime behavior is covered by
 * the index-level integration test and the core/runtime suite; here we
 * just lock down the hint-surfacing logic that decides whether to print
 * "To continue this run" and which flags to recommend.
 */

import type { RunState } from '@choirmaster/core'

import { afterEach, describe, expect, it } from 'vitest'

import { printSummary } from './run.js'

const previousInteractive = process.env._CHOIRMASTER_INTERACTIVE

afterEach(() => {
  if (previousInteractive === undefined) delete process.env._CHOIRMASTER_INTERACTIVE
  else process.env._CHOIRMASTER_INTERACTIVE = previousInteractive
})

function captureStdout(fn: () => void): string {
  const chunks: string[] = []
  const orig = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stdout.write
  try {
    fn()
  }
  finally {
    process.stdout.write = orig
  }
  return chunks.join('')
}

function makeState(tasks: { id: string; status: string; blocked_reason?: string; paused_phase?: string }[]): RunState {
  return {
    id: 'run-test',
    plan_source: 'plan.md',
    started_at: new Date().toISOString(),
    current_task: null,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.id,
      branch: 'b',
      worktree: 'w',
      allowed_paths: [],
      forbidden_paths: [],
      gates: [],
      definition_of_done: [],
      attempts: 0,
      review_iterations: 0,
      status: t.status as RunState['tasks'][number]['status'],
      blocked_reason: t.blocked_reason,
      paused_phase: t.paused_phase as RunState['tasks'][number]['paused_phase'],
    })),
  }
}

describe('printSummary', () => {
  it('prints a bare resume hint when the first incomplete task is actionable', () => {
    const out = captureStdout(() => {
      printSummary(makeState([
        { id: 'TASK-01', status: 'completed' },
        { id: 'TASK-02', status: 'waiting_for_capacity', paused_phase: 'reviewer' },
      ]), false)
    })
    expect(out).toContain('To continue this run:')
    expect(out).toContain('cm --resume run-test')
    expect(out).not.toContain('--continue-on-blocked')
  })

  it('prints a skip-blocked hint with both flags when first incomplete is blocked but later work is actionable', () => {
    const out = captureStdout(() => {
      printSummary(makeState([
        { id: 'TASK-01', status: 'completed' },
        { id: 'TASK-02', status: 'blocked', blocked_reason: 'gates failed' },
        { id: 'TASK-03', status: 'pending' },
        { id: 'TASK-04', status: 'pending' },
      ]), true)
    })
    expect(out).toContain('To continue this run (skipping blocked TASK-02):')
    expect(out).toContain('cm --resume run-test --continue-on-blocked --reuse-worktree')
  })

  it('suppresses the resume hint when every incomplete task is blocked', () => {
    const out = captureStdout(() => {
      printSummary(makeState([
        { id: 'TASK-01', status: 'completed' },
        { id: 'TASK-02', status: 'blocked', blocked_reason: 'a' },
        { id: 'TASK-03', status: 'blocked', blocked_reason: 'b' },
      ]), true)
    })
    expect(out).not.toContain('To continue this run')
    expect(out).not.toContain('cm --resume')
  })

  it('emits the slash form under _CHOIRMASTER_INTERACTIVE=1', () => {
    process.env._CHOIRMASTER_INTERACTIVE = '1'
    const out = captureStdout(() => {
      printSummary(makeState([
        { id: 'TASK-01', status: 'completed' },
        { id: 'TASK-02', status: 'blocked', blocked_reason: 'gates' },
        { id: 'TASK-03', status: 'pending' },
      ]), true)
    })
    expect(out).toContain('/resume run-test --continue-on-blocked --reuse-worktree')
    expect(out).not.toContain('cm --resume')
  })

  it('lists every leading blocked task in the skip-blocked label', () => {
    // The runtime walks past all of them with --continue-on-blocked;
    // saying "skipping blocked TASK-02" alone would undercount.
    const out = captureStdout(() => {
      printSummary(makeState([
        { id: 'TASK-01', status: 'completed' },
        { id: 'TASK-02', status: 'blocked', blocked_reason: 'a' },
        { id: 'TASK-03', status: 'blocked', blocked_reason: 'b' },
        { id: 'TASK-04', status: 'pending' },
      ]), true)
    })
    expect(out).toContain('skipping blocked task(s) TASK-02, TASK-03')
  })
})
