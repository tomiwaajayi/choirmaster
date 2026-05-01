/**
 * State-machine tests for the orchestration loop.
 *
 * Approach: keep the orchestrator code path real. We use real temp git
 * repos, real worktrees, real `runTask` state files, real shell gates
 * (tiny `node -e` commands), and real `headOnly` branch policy. Only the
 * Agent is faked - each fake just writes the handoff/review files the
 * runtime expects, or returns `capacityHit: true`, or throws to simulate
 * a kill mid-call.
 *
 * Each test's six cases lock down a behaviour the recent fixes restored:
 *   1. Implementer capacity pause resumes the same attempt (not next).
 *   2. Reviewer capacity pause resumes the same iteration (not next).
 *   3. Final-verify capacity pause resumes final-verify.
 *   4. Killed reviewer resume re-checks scope + gates and resumes review.
 *   5. Scope violation reverts the worktree and only advances the
 *      completed counter at the terminal point.
 *   6. Final-verify READY completes; final-verify BLOCKED blocks.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { headOnly } from '../branch-policy/head-only.js'
import { worktreeSandbox } from '../sandbox/worktree.js'
import type {
  Agent,
  AgentInvokeOpts,
  AgentResult,
  Handoff,
  ProjectConfig,
  Review,
  RunState,
  Task,
} from '../types.js'
import type { RuntimeContext } from './context.js'
import { HANDOFF_RELATIVE_PATH, REVIEW_RELATIVE_PATH } from './handoff.js'
import { runTask } from './loop.js'
import { saveState } from './state.js'

// ─────────────────────────────────────────────────────────────────────────────
// Test repo setup
// ─────────────────────────────────────────────────────────────────────────────

interface TestEnv {
  projectRoot: string
  runDir: string
  logsDir: string
  /** Path the gate counter file is written to. Read to count gate runs. */
  gateCounterFile: string
}

/**
 * Run a shell command synchronously, throwing on non-zero exit. Used only
 * for repo bootstrap; the runtime under test uses its own git wrappers.
 */
function sh(cmd: string, cwd: string): void {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`Command failed (exit ${r.status}): ${cmd}\n${r.stderr || r.stdout}`)
  }
}

function initRepo(): TestEnv {
  const projectRoot = mkdtempSync(join(tmpdir(), 'choir-loop-'))
  // -b main works on git >= 2.28; the test runner host has it.
  sh('git init -b main', projectRoot)
  sh('git config user.email test@example.com', projectRoot)
  sh('git config user.name "Test"', projectRoot)
  sh('git config commit.gpgsign false', projectRoot)
  writeFileSync(join(projectRoot, 'README.md'), '# test repo\n')
  sh('git add -A', projectRoot)
  sh('git commit -m "initial"', projectRoot)

  // Minimal prompt files so loadPromptFile doesn't fail.
  mkdirSync(join(projectRoot, '.choirmaster/prompts'), { recursive: true })
  writeFileSync(join(projectRoot, '.choirmaster/prompts/implementer.md'), '# implementer\n')
  writeFileSync(join(projectRoot, '.choirmaster/prompts/reviewer.md'), '# reviewer\n')

  const runDir = join(projectRoot, '.choirmaster/runs/test')
  const logsDir = join(runDir, 'logs')
  mkdirSync(logsDir, { recursive: true })

  return {
    projectRoot,
    runDir,
    logsDir,
    gateCounterFile: join(projectRoot, '.gate-runs'),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fake agent
// ─────────────────────────────────────────────────────────────────────────────

type Turn = (opts: AgentInvokeOpts) => AgentResult | Promise<AgentResult>

interface FakeAgent extends Agent {
  /** Number of `invoke` calls served. */
  readonly calls: number
  /** Turns left in the queue. */
  readonly remaining: number
}

function fakeAgent(name: string, turns: Turn[]): FakeAgent {
  let i = 0
  return {
    name,
    engine: 'fake',
    model: 'mock',
    get calls() {
      return i
    },
    get remaining() {
      return turns.length - i
    },
    async invoke(opts) {
      if (i >= turns.length) {
        throw new Error(
          `fakeAgent(${name}) called more than expected. queued=${turns.length}, label=${opts.label}`,
        )
      }
      const turn = turns[i]!
      i += 1
      return await turn(opts)
    },
  }
}

const RESULT_OK: AgentResult = {
  status: 0,
  stdout: '',
  stderr: '',
  durationMs: 1,
  capacityHit: false,
}

const RESULT_CAPACITY: AgentResult = {
  status: 1,
  stdout: '',
  stderr: 'usage limit reached',
  durationMs: 1,
  capacityHit: true,
  capacitySignal: 'usage limit reached',
}

/** Turn: simulate a capacity hit (no file written). */
const turnCapacity: Turn = async () => RESULT_CAPACITY

/** Turn: simulate a process kill mid-call by throwing. */
const turnThrow: Turn = async () => {
  throw new Error('simulated kill')
}

interface FileEdit {
  path: string
  contents: string
}

/**
 * Turn: write the given files into the worktree, then write a handoff with
 * the given verdict (defaulting non-essential fields).
 */
function turnHandoff(
  taskId: string,
  partial: Partial<Handoff> & { verdict: Handoff['verdict'] },
  edits: FileEdit[] = [],
): Turn {
  return async (opts) => {
    for (const edit of edits) {
      const abs = join(opts.cwd, edit.path)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, edit.contents)
    }
    const handoff: Handoff = {
      task_id: taskId,
      mode: 'INITIAL_IMPLEMENTATION',
      scope_ok: true,
      files_modified: [],
      files_created: edits.map((e) => e.path),
      files_deleted: [],
      missed_requirements: [],
      risky_changes: [],
      out_of_scope_observations: [],
      pushbacks: [],
      notes: 'fake handoff',
      summary_of_changes: 'fake summary',
      ...partial,
    }
    mkdirSync(join(opts.cwd, '.choirmaster'), { recursive: true })
    writeFileSync(join(opts.cwd, HANDOFF_RELATIVE_PATH), JSON.stringify(handoff))
    return RESULT_OK
  }
}

/** Turn: write a review with the given verdict. */
function turnReview(
  taskId: string,
  partial: Partial<Review> & { verdict: Review['verdict'] },
): Turn {
  return async (opts) => {
    const review: Review = {
      task_id: taskId,
      checked_at: new Date().toISOString(),
      files_reviewed: [],
      issues: [],
      notes: '',
      ...partial,
    }
    mkdirSync(join(opts.cwd, '.choirmaster'), { recursive: true })
    writeFileSync(join(opts.cwd, REVIEW_RELATIVE_PATH), JSON.stringify(review))
    return RESULT_OK
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const TASK_ID = 'TASK-01'

function buildConfig(
  env: TestEnv,
  implementerTurns: Turn[],
  reviewerTurns: Turn[],
): { config: ProjectConfig, implementer: FakeAgent, reviewer: FakeAgent } {
  const implementer = fakeAgent('impl', implementerTurns)
  const reviewer = fakeAgent('rev', reviewerTurns)
  // Gate appends one byte to a host-side file each run, so tests can count
  // gate batches across multiple runTask calls.
  const gateCmd = `node -e "require('fs').appendFileSync(process.env.GATE_COUNTER, 'x')"`
  return {
    implementer,
    reviewer,
    config: {
      base: 'main',
      // planner not used by runTask but the type requires it.
      agents: { planner: implementer, implementer, reviewer },
      gates: [
        {
          name: 'pass',
          command: `GATE_COUNTER=${JSON.stringify(env.gateCounterFile)} ${gateCmd}`,
        },
      ],
      branchPolicy: headOnly(),
      sandbox: worktreeSandbox(),
      prompts: {
        planner: '.choirmaster/prompts/implementer.md',
        planReviewer: '.choirmaster/prompts/reviewer.md',
        implementer: '.choirmaster/prompts/implementer.md',
        reviewer: '.choirmaster/prompts/reviewer.md',
      },
    },
  }
}

function buildTask(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    title: 'test task',
    branch: 'task/01',
    worktree: '.choirmaster/wt/01',
    allowed_paths: ['app/**'],
    forbidden_paths: [],
    gates: [], // empty -> use config defaults
    definition_of_done: ['file exists'],
    attempts: 0,
    review_iterations: 0,
    status: 'pending',
    ...overrides,
  }
}

function buildState(task: Task): RunState {
  return {
    id: 'test-run',
    plan_source: 'test',
    started_at: new Date().toISOString(),
    current_task: null,
    tasks: [task],
  }
}

function buildContext(env: TestEnv, config: ProjectConfig): RuntimeContext {
  return {
    projectRoot: env.projectRoot,
    runDir: env.runDir,
    logsDir: env.logsDir,
    config,
  }
}

function gateRunCount(env: TestEnv): number {
  if (!existsSync(env.gateCounterFile)) return 0
  return readFileSync(env.gateCounterFile, 'utf8').length
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('runTask', () => {
  let env: TestEnv

  beforeEach(() => {
    env = initRepo()
  })

  afterEach(() => {
    rmSync(env.projectRoot, { recursive: true, force: true })
  })

  it('implementer capacity pause resumes the same attempt', async () => {
    const { config, implementer, reviewer } = buildConfig(
      env,
      [
        turnCapacity, // run 1: implementer attempt 1 hits capacity
        turnHandoff(
          TASK_ID,
          { verdict: 'READY_FOR_REVIEW' },
          [{ path: 'app/foo.txt', contents: 'hi' }],
        ), // run 2: implementer attempt 1 (re-entered) succeeds
      ],
      [turnReview(TASK_ID, { verdict: 'READY' })],
    )
    const task = buildTask()
    const state = buildState(task)
    saveState(env.runDir, state)
    const ctx = buildContext(env, config)

    // Run 1: pauses on capacity.
    await runTask(ctx, state, task)
    expect(task.status).toBe('waiting_for_capacity')
    expect(task.paused_phase).toBe('implementer')
    expect(task.attempts).toBe(1)
    expect(task.completed_attempts ?? 0).toBe(0)

    // Run 2: resumes attempt 1, completes.
    await runTask(ctx, state, task)
    expect(task.status).toBe('completed')
    expect(task.attempts).toBe(1) // never advanced past 1
    expect(task.completed_attempts).toBe(1)

    // Both implementer turns consumed; reviewer ran once.
    expect(implementer.remaining).toBe(0)
    expect(reviewer.calls).toBe(1)
  })

  it('reviewer capacity pause resumes the same iteration', async () => {
    const { config, reviewer } = buildConfig(
      env,
      [turnHandoff(
        TASK_ID,
        { verdict: 'READY_FOR_REVIEW' },
        [{ path: 'app/foo.txt', contents: 'hi' }],
      )],
      [
        turnCapacity, // run 1: reviewer iter 1 hits capacity
        turnReview(TASK_ID, { verdict: 'READY' }), // run 2: iter 1 re-runs and approves
      ],
    )
    const task = buildTask()
    const state = buildState(task)
    saveState(env.runDir, state)
    const ctx = buildContext(env, config)

    await runTask(ctx, state, task)
    expect(task.status).toBe('waiting_for_capacity')
    expect(task.paused_phase).toBe('reviewer')
    expect(task.review_iterations).toBe(1)
    expect(task.completed_review_iterations ?? 0).toBe(0)

    await runTask(ctx, state, task)
    expect(task.status).toBe('completed')
    // Resume re-entered iter 1, not iter 2: the started counter stayed
    // at 1, and the reviewer was invoked exactly twice (capacity + ready).
    // `completed_review_iterations` doesn't advance on a READY exit -
    // it only advances after a BLOCKED-then-fix cycle ran end-to-end -
    // so it stays at 0 here.
    expect(task.review_iterations).toBe(1)
    expect(reviewer.calls).toBe(2)
    expect(reviewer.remaining).toBe(0)
  })

  it('final-verify capacity pause resumes final-verify', async () => {
    // Drive the regular reviewer loop to exhaustion (3 iters, all BLOCKED
    // with successful fixes), then capacity-hit on the final-verify call.
    // On resume, completed_review_iterations === max so the for loop is
    // skipped and final-verify re-runs.
    const fixHandoff = turnHandoff(TASK_ID, { verdict: 'READY_FOR_REVIEW' })
    const blocked: Partial<Review> & { verdict: Review['verdict'] } = {
      verdict: 'BLOCKED',
      issues: [
        {
          axis: 'spec',
          severity: 'low',
          file: 'app/foo.txt',
          line: null,
          description: 'nit',
        },
      ],
    }
    const { config, reviewer } = buildConfig(
      env,
      [
        turnHandoff(
          TASK_ID,
          { verdict: 'READY_FOR_REVIEW' },
          [{ path: 'app/foo.txt', contents: 'v1' }],
        ),
        fixHandoff, // fix iter 1
        fixHandoff, // fix iter 2
        fixHandoff, // fix iter 3
      ],
      [
        turnReview(TASK_ID, blocked), // iter 1
        turnReview(TASK_ID, blocked), // iter 2
        turnReview(TASK_ID, blocked), // iter 3
        turnCapacity, // final-verify run 1 - capacity
        turnReview(TASK_ID, { verdict: 'READY' }), // final-verify run 2 - ready
      ],
    )
    const task = buildTask()
    const state = buildState(task)
    saveState(env.runDir, state)
    const ctx = buildContext(env, config)

    await runTask(ctx, state, task)
    expect(task.status).toBe('waiting_for_capacity')
    expect(task.paused_phase).toBe('reviewer')
    // Regular loop ran to completion before final-verify fired.
    expect(task.completed_review_iterations).toBe(3)

    await runTask(ctx, state, task)
    expect(task.status).toBe('completed')
    expect(reviewer.remaining).toBe(0)
  })

  it('killed reviewer resume re-checks scope and gates, then resumes review', async () => {
    const { config } = buildConfig(
      env,
      [turnHandoff(
        TASK_ID,
        { verdict: 'READY_FOR_REVIEW' },
        [{ path: 'app/foo.txt', contents: 'hi' }],
      )],
      [
        turnThrow, // run 1: reviewer iter 1 dies mid-call (no paused_phase recorded)
        turnReview(TASK_ID, { verdict: 'READY' }), // run 2: iter 1 re-runs, approves
      ],
    )
    const task = buildTask()
    const state = buildState(task)
    saveState(env.runDir, state)
    const ctx = buildContext(env, config)

    // Run 1 throws out of the reviewer call. Runtime leaves status=in_progress,
    // paused_phase=undefined, review_iterations=1, completed_review_iterations=0.
    await expect(runTask(ctx, state, task)).rejects.toThrow('simulated kill')
    expect(task.status).toBe('in_progress')
    expect(task.paused_phase).toBeUndefined()
    expect(task.review_iterations).toBe(1)
    expect(task.completed_review_iterations ?? 0).toBe(0)
    const gatesAfterRun1 = gateRunCount(env)
    expect(gatesAfterRun1).toBeGreaterThanOrEqual(1) // post-implementer attempt 1

    // Run 2: re-enters reviewer phase, must re-verify gates first.
    await runTask(ctx, state, task)
    expect(task.status).toBe('completed')
    // Resume re-entered iter 1 (started counter unchanged, not bumped to 2).
    // The READY exit doesn't advance completed_review_iterations - same
    // rule as the capacity-pause test above.
    expect(task.review_iterations).toBe(1)
    // Resume re-check ran the gates again.
    expect(gateRunCount(env)).toBeGreaterThan(gatesAfterRun1)
  })

  it('scope violation reverts the worktree and only advances completed_attempts at terminal points', async () => {
    const { config, implementer, reviewer } = buildConfig(
      env,
      [
        // Attempt 1: writes outside allowed_paths.
        turnHandoff(
          TASK_ID,
          { verdict: 'READY_FOR_REVIEW' },
          [{ path: 'server/secret.txt', contents: 'leaked' }],
        ),
        // Attempt 2: writes inside scope.
        turnHandoff(
          TASK_ID,
          { verdict: 'READY_FOR_REVIEW' },
          [{ path: 'app/foo.txt', contents: 'hi' }],
        ),
      ],
      [turnReview(TASK_ID, { verdict: 'READY' })],
    )
    const task = buildTask()
    const state = buildState(task)
    saveState(env.runDir, state)
    const ctx = buildContext(env, config)

    await runTask(ctx, state, task)

    expect(task.status).toBe('completed')
    // Attempt counter advanced through both attempts; completed counter
    // only advanced at terminal points (after each cycle finished its
    // checks), reaching 2 by the time attempt 2 was marked complete.
    expect(task.attempts).toBe(2)
    expect(task.completed_attempts).toBe(2)
    expect(implementer.remaining).toBe(0)
    expect(reviewer.calls).toBe(1)

    // The out-of-scope file from attempt 1 was reverted; only the in-scope
    // file from attempt 2 should remain in the worktree.
    const worktree = join(env.projectRoot, task.worktree)
    expect(existsSync(join(worktree, 'server/secret.txt'))).toBe(false)
    expect(existsSync(join(worktree, 'app/foo.txt'))).toBe(true)
  })

  it('final-verify READY completes the task', async () => {
    const fixHandoff = turnHandoff(TASK_ID, { verdict: 'READY_FOR_REVIEW' })
    const blocked: Partial<Review> & { verdict: Review['verdict'] } = {
      verdict: 'BLOCKED',
      issues: [
        {
          axis: 'spec',
          severity: 'low',
          file: 'app/foo.txt',
          line: null,
          description: 'nit',
        },
      ],
    }
    const { config } = buildConfig(
      env,
      [
        turnHandoff(
          TASK_ID,
          { verdict: 'READY_FOR_REVIEW' },
          [{ path: 'app/foo.txt', contents: 'v1' }],
        ),
        fixHandoff,
        fixHandoff,
        fixHandoff,
      ],
      [
        turnReview(TASK_ID, blocked),
        turnReview(TASK_ID, blocked),
        turnReview(TASK_ID, blocked),
        turnReview(TASK_ID, { verdict: 'READY' }),
      ],
    )
    const task = buildTask()
    const state = buildState(task)
    saveState(env.runDir, state)
    const ctx = buildContext(env, config)

    await runTask(ctx, state, task)
    expect(task.status).toBe('completed')
    expect(task.completed_review_iterations).toBe(3)
  })

  it('final-verify BLOCKED blocks the task', async () => {
    const fixHandoff = turnHandoff(TASK_ID, { verdict: 'READY_FOR_REVIEW' })
    const blocked: Partial<Review> & { verdict: Review['verdict'] } = {
      verdict: 'BLOCKED',
      issues: [
        {
          axis: 'spec',
          severity: 'low',
          file: 'app/foo.txt',
          line: null,
          description: 'nit',
        },
      ],
    }
    const { config } = buildConfig(
      env,
      [
        turnHandoff(
          TASK_ID,
          { verdict: 'READY_FOR_REVIEW' },
          [{ path: 'app/foo.txt', contents: 'v1' }],
        ),
        fixHandoff,
        fixHandoff,
        fixHandoff,
      ],
      [
        turnReview(TASK_ID, blocked),
        turnReview(TASK_ID, blocked),
        turnReview(TASK_ID, blocked),
        turnReview(TASK_ID, blocked), // final-verify also blocks
      ],
    )
    const task = buildTask()
    const state = buildState(task)
    saveState(env.runDir, state)
    const ctx = buildContext(env, config)

    await runTask(ctx, state, task)
    expect(task.status).toBe('blocked')
    expect(task.blocked_reason ?? '').toMatch(/final-verify/)
  })
})
