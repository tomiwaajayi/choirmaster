/**
 * `runPlanner`: turn a markdown plan into a validated `*.tasks.json`.
 *
 * Single-shot today. The planner agent reads the plan markdown, explores
 * the codebase, and writes `.choirmaster/plan-output.json` at the project
 * root. The runtime then validates the output through `validateTasksFile`
 * and (on success) copies it to the caller's chosen tasks-file path.
 *
 * No iteration loop yet. A plan-reviewer pass that catches "too broad" and
 * "scope ambiguous" plans is on the roadmap (Phase 2B); this slice exists
 * so users can stop hand-authoring tasks.json files end-to-end.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  AgentEvent,
  Task,
} from '../types.js'

import type { RuntimeContext } from './context.js'
import { ensureParent, type TaskLogger } from './log.js'
import { buildSystemPrompt, loadPromptFile } from './prompt.js'
import { validateTasksFile } from './tasks-file.js'

export const PLAN_OUTPUT_RELATIVE_PATH = '.choirmaster/plan-output.json'

/**
 * Tools the planner is allowed to use. Read-only on the codebase plus a
 * narrow Write so the agent can emit `plan-output.json`. The Bash subset
 * mirrors what the implementer gets minus anything that mutates state.
 */
const PLANNER_TOOLS = [
  'Read', 'Glob', 'Grep', 'Write',
  'Bash(git status:*)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git ls-files:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(cat:*)',
  'Bash(ls:*)',
  'Bash(wc:*)',
  'Bash(find:*)',
]

const DEFAULT_AGENT_TURN_TIMEOUT_MS = 30 * 60 * 1000

export interface RunPlannerOptions {
  /** Absolute path to the markdown plan file. */
  planPath: string
  /** Absolute path where the validated `*.tasks.json` should land. */
  outputPath: string
  /** Optional logger; if omitted, planner logs go to stdout only. */
  logger?: TaskLogger
}

export type RunPlannerResult =
  | {
    ok: true
    tasksGenerated: number
    /** Absolute path the validated tasks file was written to. */
    outputPath: string
    /** Tasks the planner produced, in topological order. */
    tasks: Task[]
  }
  | {
    ok: false
    /** Validation or runtime errors, one per line. */
    errors: string[]
    /**
     * If the agent did write something but it failed validation, the raw
     * output is preserved at this path so the caller can inspect it.
     * Undefined when the agent produced no file at all.
     */
    rawOutputPath?: string
    /** Truthy when the planner agent hit a capacity limit mid-call. */
    capacityHit?: boolean
  }

/**
 * Drive a single planner turn, validate the output, write to disk.
 */
export async function runPlanner(
  ctx: RuntimeContext,
  options: RunPlannerOptions,
): Promise<RunPlannerResult> {
  const { planPath, outputPath, logger } = options

  if (!existsSync(planPath)) {
    return { ok: false, errors: [`plan file not found: ${planPath}`] }
  }

  const planMarkdown = readFileSync(planPath, 'utf8')

  const planner = ctx.config.agents.planner
  const systemPrompt = buildSystemPrompt(
    loadPromptFile(ctx.projectRoot, ctx.config.prompts.planner),
    ctx.config,
  )
  const userPrompt = buildPlannerUserPrompt(planMarkdown, planPath, ctx)

  // Clear any stale output before the agent runs so we can't accidentally
  // pick up a previous run's file when the new turn writes nothing.
  const outputAbs = join(ctx.projectRoot, PLAN_OUTPUT_RELATIVE_PATH)
  if (existsSync(outputAbs)) rmSync(outputAbs)

  logger?.line(`Invoking ${planner.name} (planner) in ${ctx.projectRoot}`)
  const t0 = Date.now()
  const result = await planner.invoke(
    {
      systemPrompt,
      userPrompt,
      cwd: ctx.projectRoot,
      taskId: 'PLAN',
      label: 'planner',
      allowedTools: PLANNER_TOOLS,
      timeoutMs: ctx.config.limits?.agentTurnTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS,
    },
    (event: AgentEvent) => streamEventToLogger(logger, event),
  )
  logger?.line(`${planner.name} (planner) finished in ${Date.now() - t0}ms; exit ${result.status}`)

  if (result.capacityHit) {
    return {
      ok: false,
      errors: [
        `Planner hit capacity: "${result.capacitySignal ?? 'capacity hit'}". Re-run after the cap window resets.`,
      ],
      capacityHit: true,
    }
  }

  if (!existsSync(outputAbs)) {
    return {
      ok: false,
      errors: [
        `Planner finished without writing ${PLAN_OUTPUT_RELATIVE_PATH}. Check the planner prompt and agent logs.`,
      ],
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(outputAbs, 'utf8'))
  }
  catch (err) {
    return {
      ok: false,
      errors: [`Planner output is not valid JSON: ${(err as Error).message}`],
      rawOutputPath: outputAbs,
    }
  }

  const validation = validateTasksFile(parsed)
  if (!validation.ok) {
    return {
      ok: false,
      errors: validation.errors,
      rawOutputPath: outputAbs,
    }
  }

  // Write the validated, normalized list to the caller's chosen path. We
  // re-serialize from the validated Task[] so any incidental fields the
  // agent added are dropped and the on-disk file matches the schema the
  // runtime will read back.
  ensureParent(outputPath)
  writeFileSync(outputPath, JSON.stringify(validation.tasks, null, 2) + '\n')

  // Clean up the transient planner-output file once we've persisted the
  // validated copy. Leaves the workspace tidy for the next plan run.
  rmSync(outputAbs)

  return {
    ok: true,
    tasksGenerated: validation.tasks.length,
    outputPath,
    tasks: validation.tasks,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

function buildPlannerUserPrompt(
  planMarkdown: string,
  planPath: string,
  ctx: RuntimeContext,
): string {
  const projectForbidden = ctx.config.forbiddenPaths ?? []
  const lines: string[] = [
    `# Plan input`,
    '',
    `You are decomposing the plan below into a JSON list of tasks. Read the`,
    `plan, explore the codebase as needed, and write your output to`,
    `\`${PLAN_OUTPUT_RELATIVE_PATH}\`. Do not edit any other files.`,
    '',
    `Plan source: ${planPath}`,
    `Base branch: ${ctx.config.base}`,
    '',
    'Project-wide forbidden paths (any task that targets these is invalid):',
    ...(projectForbidden.length > 0
      ? projectForbidden.map((p) => `  - ${p}`)
      : ['  (none declared in the manifest)']),
    '',
    '---',
    '',
    '## Plan markdown',
    '',
    planMarkdown.trim(),
  ]
  return lines.join('\n')
}

function streamEventToLogger(logger: TaskLogger | undefined, event: AgentEvent): void {
  switch (event.kind) {
    case 'text':
      process.stdout.write(event.text)
      logger?.raw(event.text)
      break
    case 'tool_use':
      process.stdout.write(`\n  → ${event.name}\n`)
      logger?.raw(`\n  → ${event.name} ${JSON.stringify(event.input).slice(0, 200)}\n`)
      break
    case 'tool_result':
      if (!event.ok && event.snippet) {
        process.stdout.write(`  ✗ ${event.snippet}\n`)
        logger?.raw(`  ✗ ${event.snippet}\n`)
      }
      break
    case 'error':
      process.stderr.write(`[error] ${event.message}\n`)
      logger?.raw(`[error] ${event.message}\n`)
      break
    case 'thinking':
      // Hidden from terminal; not appended to log.
      break
  }
}
