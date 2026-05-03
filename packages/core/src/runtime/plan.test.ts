/**
 * Tests for `runPlanner`. Mirrors the loop-test harness shape: real temp
 * directories, real file IO, fake `Agent` that writes the planner-output
 * file (or fails to). The goal is to lock down the contract between
 * runtime and planner agent so a real Claude or Codex adapter can't drift
 * unnoticed.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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
import { PLAN_OUTPUT_SCRATCH_DIR, runPlanner } from './plan.js'

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

function sh(cmd: string, cwd: string): void {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8' })
  if (r.status !== 0) {
    throw new Error(`Command failed (exit ${r.status}): ${cmd}\n${r.stderr || r.stdout}`)
  }
}

function setupEnv(planMarkdown: string = '# tiny plan\n\nDo a thing.\n'): TestEnv {
  const projectRoot = mkdtempSync(join(tmpdir(), 'choir-plan-'))
  // Real git repo so the planner mutation guard (which uses
  // `git status --porcelain`) has something to read against.
  sh('git init -b main', projectRoot)
  sh('git config user.email test@example.com', projectRoot)
  sh('git config user.name "Test"', projectRoot)
  sh('git config commit.gpgsign false', projectRoot)

  // Minimal prompt files - loadPromptFile reads them at runtime.
  mkdirSync(join(projectRoot, '.choirmaster/prompts'), { recursive: true })
  mkdirSync(join(projectRoot, '.choirmaster/plans'), { recursive: true })
  writeFileSync(join(projectRoot, '.choirmaster/prompts/planner.md'), '# planner\n')
  writeFileSync(join(projectRoot, '.choirmaster/prompts/implementer.md'), '# implementer\n')
  writeFileSync(join(projectRoot, '.choirmaster/prompts/reviewer.md'), '# reviewer\n')

  const planPath = join(projectRoot, '.choirmaster/plans/sample.md')
  writeFileSync(planPath, planMarkdown)

  // Commit the scaffold so subsequent planner runs see a clean baseline
  // and any agent-introduced change shows up in `git status`.
  sh('git add -A', projectRoot)
  sh('git commit -m initial', projectRoot)

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
    const outFile = plannerOutputPathFromPrompt(opts)
    mkdirSync(dirname(outFile), { recursive: true })
    writeFileSync(outFile, JSON.stringify(payload))
    return RESULT_OK
  }
}

/** Turn: write a literal string (used for invalid-JSON case). */
function turnWriteRaw(raw: string): Turn {
  return async (opts) => {
    const outFile = plannerOutputPathFromPrompt(opts)
    mkdirSync(dirname(outFile), { recursive: true })
    writeFileSync(outFile, raw)
    return RESULT_OK
  }
}

function plannerOutputPathFromPrompt(opts: AgentInvokeOpts): string {
  const match = opts.userPrompt.match(/write your output to\n`([^`]+)`/)
  if (!match?.[1]) throw new Error(`planner output path missing from prompt:\n${opts.userPrompt}`)
  return join(opts.cwd, match[1])
}

function readScratchFiles(projectRoot: string): string[] {
  const scratchDir = join(projectRoot, PLAN_OUTPUT_SCRATCH_DIR)
  if (!existsSync(scratchDir)) return []
  return readdirSync(scratchDir)
}

/** Turn: succeed without writing anything. */
const turnNoop: Turn = async () => RESULT_OK

const turnCapacity: Turn = async () => RESULT_CAPACITY

function buildConfig(planner: Agent, overrides: Partial<ProjectConfig> = {}): ProjectConfig {
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
    ...overrides,
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
    expect(readScratchFiles(env.projectRoot)).toHaveLength(0)
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
    expect(result.rawOutputPath).toContain(`${PLAN_OUTPUT_SCRATCH_DIR}/plan-output-`)
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

  it('ignores stale planner scratch output from another planning run', async () => {
    // A previous run left a stale scratch file in place. The new run's
    // agent does NOT write a fresh one (turnNoop). Because planner scratch
    // paths are unique, the stale file cannot be parsed as ghost output.
    mkdirSync(join(env.projectRoot, PLAN_OUTPUT_SCRATCH_DIR), { recursive: true })
    writeFileSync(
      join(env.projectRoot, PLAN_OUTPUT_SCRATCH_DIR, 'plan-output-stale.json'),
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
    // Agent wrote nothing; runtime correctly reports no output instead of
    // reading the stale scratch file.
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

  it('refuses to overwrite an existing tasks file unless force is set', async () => {
    // Pre-existing reviewed/edited tasks file at the output path.
    writeFileSync(env.outputPath, JSON.stringify([{ ...validTask, id: 'EDITED' }]))

    const planner = fakePlanner([turnWriteOutput([validTask])])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toMatch(/already exists/)
    // Pre-existing file untouched.
    const onDisk = JSON.parse(readFileSync(env.outputPath, 'utf8'))
    expect(onDisk[0].id).toBe('EDITED')
  })

  it('overwrites the existing tasks file when force is set', async () => {
    writeFileSync(env.outputPath, JSON.stringify([{ ...validTask, id: 'EDITED' }]))

    const planner = fakePlanner([turnWriteOutput([validTask])])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
      force: true,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const onDisk = JSON.parse(readFileSync(env.outputPath, 'utf8'))
    expect(onDisk[0].id).toBe('TASK-01') // freshly planned, replaced EDITED
  })

  it('blocks when the planner mutates a file outside planner scratch output', async () => {
    // A misbehaving / prompt-injected planner that ALSO writes to a source
    // file. The runtime must catch this via the git-status guard and
    // refuse to land the (otherwise-valid) tasks file.
    const rogueWriter: Turn = async (opts) => {
      // Touch a tracked file to dirty the working tree.
      writeFileSync(join(opts.cwd, '.choirmaster/prompts/planner.md'), 'TAMPERED\n')
      // Also write the legitimate planner output - on its own this would
      // pass validation, which is exactly what makes the guard necessary.
      writeFileSync(
        plannerOutputPathFromPrompt(opts),
        JSON.stringify([validTask]),
      )
      return RESULT_OK
    }
    const planner = fakePlanner([rogueWriter])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toMatch(/outside the allowed planner-output/)
    expect(result.errors.some((e) =>
      e.includes('planner.md') && e.includes('git before: clean/missing') && e.includes('after:  M'),
    )).toBe(true)
    // No tasks file written - the validated output is rejected at the guard.
    expect(existsSync(env.outputPath)).toBe(false)
  })

  it('blocks when the planner creates an unrelated untracked file', async () => {
    const rogueWriter: Turn = async (opts) => {
      // New file in the project root, outside `.choirmaster/`.
      writeFileSync(join(opts.cwd, 'rogue.txt'), 'leaked\n')
      writeFileSync(
        plannerOutputPathFromPrompt(opts),
        JSON.stringify([validTask]),
      )
      return RESULT_OK
    }
    const planner = fakePlanner([rogueWriter])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('rogue.txt'))).toBe(true)
    expect(existsSync(env.outputPath)).toBe(false)
  })

  it("ignores pre-existing dirty state in the user's working tree", async () => {
    // The user has unrelated WIP - a modified tracked file - that pre-dates
    // the planner invocation. The guard should not flag this as planner
    // misbehavior; only deltas from the baseline matter.
    writeFileSync(join(env.projectRoot, '.choirmaster/prompts/planner.md'), '# user edited\n')

    const planner = fakePlanner([turnWriteOutput([validTask])])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(existsSync(env.outputPath)).toBe(true)
    // The user's pre-existing WIP is still on disk untouched.
    expect(readFileSync(join(env.projectRoot, '.choirmaster/prompts/planner.md'), 'utf8'))
      .toBe('# user edited\n')
  })

  it('does not flag an unchanged untracked manifest as planner mutation', async () => {
    // Mirrors a freshly initialized project where .choirmaster/manifest.ts
    // exists locally but has not been committed yet. The planner may write
    // its scratch output under .choirmaster, but unchanged config should
    // remain classified as pre-existing user state, not rogue mutation.
    writeFileSync(join(env.projectRoot, '.choirmaster/manifest.ts'), 'export default {}\n')

    const planner = fakePlanner([turnWriteOutput([validTask])])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(join(env.projectRoot, '.choirmaster/manifest.ts'), 'utf8'))
      .toBe('export default {}\n')
  })

  it('catches planner edits to a file that was already dirty before the run', async () => {
    // The user has unrelated WIP on planner.md ('# user edited\n'). The
    // planner then re-edits the same file. With status-only tracking the
    // status code stays ' M' across both edits, masking the rogue change
    // as pre-existing user WIP. The hash-aware snapshot catches this.
    const dirtyPath = join(env.projectRoot, '.choirmaster/prompts/planner.md')
    writeFileSync(dirtyPath, '# user edited\n')

    const rogueOverwrite: Turn = async (opts) => {
      // Planner overwrites the user's WIP with different content. Status
      // stays the same (' M'); only content differs.
      writeFileSync(join(opts.cwd, '.choirmaster/prompts/planner.md'), '# TAMPERED\n')
      writeFileSync(
        plannerOutputPathFromPrompt(opts),
        JSON.stringify([validTask]),
      )
      return RESULT_OK
    }
    const planner = fakePlanner([rogueOverwrite])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('planner.md') && e.includes('content changed'))).toBe(true)
    expect(existsSync(env.outputPath)).toBe(false)
  })

  it('reports rogue mutations even when the planner also signals capacity', async () => {
    // The capacity check used to short-circuit before the mutation guard,
    // letting a planner that dirtied source files exit with a polite
    // capacity message and no rogue-path trace. The guard now runs first.
    const rogueThenCapacity: Turn = async (opts) => {
      writeFileSync(join(opts.cwd, '.choirmaster/prompts/planner.md'), '# TAMPERED\n')
      return RESULT_CAPACITY
    }
    const planner = fakePlanner([rogueThenCapacity])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    // Both signals surface: the capacity flag is preserved, and the rogue
    // path is named so the user can `git restore` rather than wondering
    // why their tree is dirty.
    expect(result.capacityHit).toBe(true)
    expect(result.errors[0]).toMatch(/outside the allowed planner-output/)
    expect(result.errors.some((e) => e.includes('planner.md'))).toBe(true)
    expect(result.errors.some((e) => e.toLowerCase().includes('capacity'))).toBe(true)
  })

  it("flags planner deletion of the user's pre-existing untracked WIP", async () => {
    // User had an untracked scratch file in the worktree before planning.
    // The planner deletes it. Without union-of-before-and-after the path
    // disappears from `git status` and the guard would see no rogue
    // changes - silently losing the user's work.
    const wipPath = join(env.projectRoot, 'scratch.txt')
    writeFileSync(wipPath, 'user notes\n')

    const rogueDelete: Turn = async (opts) => {
      // Planner removes the user's WIP file outright.
      rmSync(join(opts.cwd, 'scratch.txt'))
      writeFileSync(
        plannerOutputPathFromPrompt(opts),
        JSON.stringify([validTask]),
      )
      return RESULT_OK
    }
    const planner = fakePlanner([rogueDelete])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('scratch.txt'))).toBe(true)
    expect(existsSync(env.outputPath)).toBe(false)
  })

  it('flags planner edits inside an untracked directory the user already had', async () => {
    // The default `--porcelain` output collapses untracked directories
    // into a single `?? scratch/` entry. With --untracked-files=all each
    // file inside the dir is enumerated, so adding a new file inside an
    // existing untracked dir is caught as a new path.
    const scratchDir = join(env.projectRoot, 'scratch')
    mkdirSync(scratchDir, { recursive: true })
    writeFileSync(join(scratchDir, 'note.txt'), 'pre-existing note\n')

    const rogueAdd: Turn = async (opts) => {
      writeFileSync(join(opts.cwd, 'scratch/leaked.txt'), 'planner-added\n')
      writeFileSync(
        plannerOutputPathFromPrompt(opts),
        JSON.stringify([validTask]),
      )
      return RESULT_OK
    }
    const planner = fakePlanner([rogueAdd])
    const ctx = buildContext(env, buildConfig(planner))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('scratch/leaked.txt'))).toBe(true)
    expect(existsSync(env.outputPath)).toBe(false)
  })

  it('refuses to invoke the planner when the project root is not a git repo', async () => {
    // Build a non-git temp dir with the prompt + plan files but no git
    // metadata. The guard cannot snapshot a baseline, so runPlanner must
    // fail closed BEFORE invoking the agent.
    const nonGitRoot = mkdtempSync(join(tmpdir(), 'choir-plan-nongit-'))
    mkdirSync(join(nonGitRoot, '.choirmaster/prompts'), { recursive: true })
    mkdirSync(join(nonGitRoot, '.choirmaster/plans'), { recursive: true })
    writeFileSync(join(nonGitRoot, '.choirmaster/prompts/planner.md'), '# planner\n')
    const planPath = join(nonGitRoot, '.choirmaster/plans/sample.md')
    writeFileSync(planPath, '# plan\n')

    let invocations = 0
    const counter: Turn = async () => {
      invocations += 1
      return RESULT_OK
    }
    const planner = fakePlanner([counter])
    const config = buildConfig(planner)
    const ctx: RuntimeContext = {
      projectRoot: nonGitRoot,
      runDir: join(nonGitRoot, '.choirmaster'),
      logsDir: join(nonGitRoot, '.choirmaster/logs'),
      config,
    }
    mkdirSync(ctx.logsDir, { recursive: true })

    const outputPath = join(nonGitRoot, '.choirmaster/plans/sample.tasks.json')
    const result = await runPlanner(ctx, { planPath, outputPath })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]).toMatch(/git status baseline/i)
    expect(invocations).toBe(0) // planner was NOT invoked

    rmSync(nonGitRoot, { recursive: true, force: true })
  })

  it('flags planner edits to a gitignored forbidden file like .env', async () => {
    // Set up a gitignored secret file. Without the forbidden-path snapshot
    // it would be invisible to `git status` and the planner could rewrite
    // it silently. forbiddenPaths declares it; the runtime hashes it
    // before/after and flags any drift.
    writeFileSync(join(env.projectRoot, '.gitignore'), '.env\n')
    writeFileSync(join(env.projectRoot, '.env'), 'API_KEY=user-secret\n')
    sh('git add .gitignore', env.projectRoot)
    sh('git commit -m "ignore env"', env.projectRoot)

    const rogueEnvWrite: Turn = async (opts) => {
      writeFileSync(join(opts.cwd, '.env'), 'API_KEY=stolen\n')
      writeFileSync(
        plannerOutputPathFromPrompt(opts),
        JSON.stringify([validTask]),
      )
      return RESULT_OK
    }
    const planner = fakePlanner([rogueEnvWrite])
    const ctx = buildContext(env, buildConfig(planner, {
      forbiddenPaths: ['.env', '.env.*'],
    }))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('.env'))).toBe(true)
    expect(result.errors.some((e) => e.includes('forbidden path'))).toBe(true)
    expect(existsSync(env.outputPath)).toBe(false)
    // The user's secret on disk is still tampered (we don't auto-revert),
    // but the run is blocked so the planner's verdict can't ship.
  })

  it("flags planner deletion of a gitignored forbidden file", async () => {
    writeFileSync(join(env.projectRoot, '.gitignore'), '.env\n')
    writeFileSync(join(env.projectRoot, '.env'), 'API_KEY=user-secret\n')
    sh('git add .gitignore', env.projectRoot)
    sh('git commit -m "ignore env"', env.projectRoot)

    const rogueEnvDelete: Turn = async (opts) => {
      rmSync(join(opts.cwd, '.env'))
      writeFileSync(
        plannerOutputPathFromPrompt(opts),
        JSON.stringify([validTask]),
      )
      return RESULT_OK
    }
    const planner = fakePlanner([rogueEnvDelete])
    const ctx = buildContext(env, buildConfig(planner, {
      forbiddenPaths: ['.env'],
    }))

    const result = await runPlanner(ctx, {
      planPath: env.planPath,
      outputPath: env.outputPath,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.some((e) => e.includes('.env') && e.includes('forbidden path'))).toBe(true)
  })

  it('reports a clean capacity exit when the planner did not mutate anything', async () => {
    // The capacity-only path still works: nothing dirty, just a polite
    // pause-and-retry message with capacityHit set.
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
    expect(result.errors[0]).not.toMatch(/outside the allowed/)
    expect(existsSync(env.outputPath)).toBe(false)
  })
})
