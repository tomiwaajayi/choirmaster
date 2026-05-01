/**
 * Tests for `runPlanner`. Mirrors the loop-test harness shape: real temp
 * directories, real file IO, fake `Agent` that writes the planner-output
 * file (or fails to). The goal is to lock down the contract between
 * runtime and planner agent so a real Claude or Codex adapter can't drift
 * unnoticed.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { headOnly } from '../branch-policy/head-only.js'
import { worktreeSandbox } from '../sandbox/worktree.js'
import type {
  Agent,
  AgentInvokeOpts,
  AgentResult,
  ProjectConfig,
} from '../types.js'
import type { RuntimeContext } from './context.js'
import { PLAN_OUTPUT_RELATIVE_PATH, runPlanner } from './plan.js'

// ─────────────────────────────────────────────────────────────────────────────
// Test scaffolding
// ─────────────────────────────────────────────────────────────────────────────

interface TestEnv {
  projectRoot: string
  runDir: string
  logsDir: string
  planPath: string
  outputPath: string
}

function setupEnv(planMarkdown: string = '# tiny plan\n\nDo a thing.\n'): TestEnv {
  const projectRoot = mkdtempSync(join(tmpdir(), 'choir-plan-'))
  // Minimal prompt files - loadPromptFile reads them at runtime.
  mkdirSync(join(projectRoot, '.choirmaster/prompts'), { recursive: true })
  mkdirSync(join(projectRoot, '.choirmaster/plans'), { recursive: true })
  writeFileSync(join(projectRoot, '.choirmaster/prompts/planner.md'), '# planner\n')
  writeFileSync(join(projectRoot, '.choirmaster/prompts/implementer.md'), '# implementer\n')
  writeFileSync(join(projectRoot, '.choirmaster/prompts/reviewer.md'), '# reviewer\n')

  const planPath = join(projectRoot, '.choirmaster/plans/sample.md')
  writeFileSync(planPath, planMarkdown)

  const outputPath = join(projectRoot, '.choirmaster/plans/sample.tasks.json')
  const runDir = join(projectRoot, '.choirmaster')
  const logsDir = join(runDir, 'logs')
  mkdirSync(logsDir, { recursive: true })

  return { projectRoot, runDir, logsDir, planPath, outputPath }
}

type Turn = (opts: AgentInvokeOpts) => AgentResult | Promise<AgentResult>

function fakePlanner(turns: Turn[]): Agent {
  let i = 0
  return {
    name: 'fake-planner',
    engine: 'fake',
    model: 'mock',
    async invoke(opts) {
      if (i >= turns.length) {
        throw new Error(`fake planner called more than expected (${turns.length})`)
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

/** Turn: write the given JSON to the planner-output file, then succeed. */
function turnWriteOutput(payload: unknown): Turn {
  return async (opts) => {
    const outFile = join(opts.cwd, PLAN_OUTPUT_RELATIVE_PATH)
    mkdirSync(join(opts.cwd, '.choirmaster'), { recursive: true })
    writeFileSync(outFile, JSON.stringify(payload))
    return RESULT_OK
  }
}

/** Turn: write a literal string (used for invalid-JSON case). */
function turnWriteRaw(raw: string): Turn {
  return async (opts) => {
    const outFile = join(opts.cwd, PLAN_OUTPUT_RELATIVE_PATH)
    mkdirSync(join(opts.cwd, '.choirmaster'), { recursive: true })
    writeFileSync(outFile, raw)
    return RESULT_OK
  }
}

/** Turn: succeed without writing anything. */
const turnNoop: Turn = async () => RESULT_OK

const turnCapacity: Turn = async () => RESULT_CAPACITY

function buildConfig(planner: Agent): ProjectConfig {
  return {
    base: 'main',
    agents: { planner, implementer: planner, reviewer: planner },
    gates: [],
    branchPolicy: headOnly(),
    sandbox: worktreeSandbox(),
    prompts: {
      planner: '.choirmaster/prompts/planner.md',
      planReviewer: '.choirmaster/prompts/planner.md',
      implementer: '.choirmaster/prompts/implementer.md',
      reviewer: '.choirmaster/prompts/reviewer.md',
    },
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

const validTask = {
  id: 'TASK-01',
  title: 'sample',
  branch: 'choirmaster/task-01',
  worktree: '.choirmaster/runs/active/wt/task-01',
  allowed_paths: ['app/**'],
  definition_of_done: ['it works'],
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('runPlanner', () => {
  let env: TestEnv

  beforeEach(() => {
    env = setupEnv()
  })

  afterEach(() => {
    rmSync(env.projectRoot, { recursive: true, force: true })
  })

  it('writes the validated tasks file and returns the parsed Task[]', async () => {
    const planner = fakePlanner([turnWriteOutput([validTask])])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return // narrow for TS
    expect(result.tasksGenerated).toBe(1)
    expect(result.outputPath).toBe(env.outputPath)
    expect(result.tasks[0]?.id).toBe('TASK-01')
    // Validated tasks file landed at the requested path.
    expect(existsSync(env.outputPath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(env.outputPath, 'utf8'))
    expect(Array.isArray(onDisk)).toBe(true)
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].id).toBe('TASK-01')
    // Transient planner-output file cleaned up.
    expect(existsSync(join(env.projectRoot, PLAN_OUTPUT_RELATIVE_PATH))).toBe(false)
  })

  it('reports validation errors when the planner emits an invalid task', async () => {
    const planner = fakePlanner([turnWriteOutput([
      // Missing required fields - id, title, branch, etc.
      { allowed_paths: ['app/**'] },
    ])])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors.some((e) => e.includes('tasks[0].id'))).toBe(true)
    // Raw output preserved for debugging.
    expect(result.rawOutputPath).toBe(join(env.projectRoot, PLAN_OUTPUT_RELATIVE_PATH))
    expect(existsSync(result.rawOutputPath!)).toBe(true)
    // No tasks file written.
    expect(existsSync(env.outputPath)).toBe(false)
  })

  it('reports an error when the planner output is not valid JSON', async () => {
    const planner = fakePlanner([turnWriteRaw('not json {')])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toMatch(/not valid JSON/)
    expect(result.rawOutputPath).toBeDefined()
  })

  it('reports a clear error when the planner finishes without writing output', async () => {
    const planner = fakePlanner([turnNoop])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toMatch(/without writing/)
    // Nothing on disk to point at.
    expect(result.rawOutputPath).toBeUndefined()
  })

  it('surfaces capacity hits as a recoverable failure', async () => {
    const planner = fakePlanner([turnCapacity])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.capacityHit).toBe(true)
    expect(result.errors[0]).toMatch(/capacity/i)
  })

  it('clears stale planner-output before invoking the agent', async () => {
    // A previous run left a stale plan-output.json in place. The new run's
    // agent does NOT write a fresh one (turnNoop). Without the clear, the
    // stale file would be parsed and validation would either accept the
    // ghost data or report misleading errors.
    mkdirSync(join(env.projectRoot, '.choirmaster'), { recursive: true })
    writeFileSync(
      join(env.projectRoot, PLAN_OUTPUT_RELATIVE_PATH),
      JSON.stringify([{ ...validTask, id: 'STALE' }]),
    )

    const planner = fakePlanner([turnNoop])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    // The stale file was cleared before the agent ran; agent wrote
    // nothing; runtime correctly reports no output.
    expect(result.errors[0]).toMatch(/without writing/)
  })

  it('reports a clear error when the plan file does not exist', async () => {
    const planner = fakePlanner([turnNoop])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: join(env.projectRoot, '.choirmaster/plans/missing.md'),
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toMatch(/plan file not found/)
  })
})
