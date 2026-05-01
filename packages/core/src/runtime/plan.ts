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

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  AgentEvent,
  Task,
} from '../types.js'

import type { RuntimeContext } from './context.js'
import { git } from './git.js'
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
  /**
   * Allow overwriting an existing tasks file at `outputPath`. The default
   * is `false`: planning refuses to clobber a previously generated or
   * hand-edited task file, since the intended workflow is to review/edit
   * the generated tasks before running. The `run <plan.md>` plan-then-run
   * path passes `true` because that flow's whole point is fresh planning.
   */
  force?: boolean
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
  const { planPath, outputPath, force = false, logger } = options

  if (!existsSync(planPath)) {
    return { ok: false, errors: [`plan file not found: ${planPath}`] }
  }

  // Refuse to clobber a hand-edited or previously reviewed tasks file
  // unless the caller explicitly asks. Plan-then-run from `run <plan.md>`
  // passes force=true; standalone `choirmaster plan` defaults to refusing.
  if (existsSync(outputPath) && !force) {
    return {
      ok: false,
      errors: [
        `${outputPath} already exists. Pass --force to overwrite, or delete the file first.`,
      ],
    }
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

  // Snapshot the project's git status BEFORE the planner runs. The planner
  // operates on the real project root with Write access (so it can produce
  // plan-output.json), which means a misbehaving or prompt-injected planner
  // could mutate source files on the user's branch. After the turn we'll
  // diff this snapshot against the post-run status and refuse to commit
  // the planner's verdict if anything outside `.choirmaster/plan-output.json`
  // changed. We do NOT auto-revert - the user may have unrelated WIP we
  // shouldn't touch - but we tell them exactly what moved so they can
  // `git restore` themselves.
  const baselineStatus = gitStatusSnapshot(ctx.projectRoot)

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

  // Project-root mutation guard. The only path the planner is allowed to
  // touch is `.choirmaster/plan-output.json`. Anything else - source
  // edits, gitignore tweaks, new untracked files - is treated as a
  // contract violation. This check fires BEFORE the capacity early
  // return: a planner that dirties source files and then signals
  // capacity must still surface those rogue paths to the user, otherwise
  // the project root is left dirty with no error trace.
  const rogue = unauthorizedChanges(ctx.projectRoot, baselineStatus)
  if (rogue.length > 0) {
    const errors = [
      'Planner mutated files outside the allowed planner-output path. Aborting before writing tasks.json.',
      'Affected paths (review and `git restore` as needed):',
      ...rogue.map((path) => `  - ${path}`),
    ]
    if (result.capacityHit) {
      errors.push(
        `Planner also reported capacity ("${result.capacitySignal ?? 'capacity hit'}"); the rogue edits above happened before the capacity signal.`,
      )
    }
    return { ok: false, errors, capacityHit: result.capacityHit }
  }

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

interface StatusEntry {
  /** Two-character `git status --porcelain` code, e.g. " M", "??". */
  status: string
  /** SHA-256 of the on-disk content; empty string if the file isn't readable. */
  hash: string
}

/**
 * Snapshot every dirty path according to `git status --porcelain`, with
 * both the status code AND a content hash. Status alone isn't enough -
 * a file that was already ` M` can stay ` M` while the planner rewrites
 * its content, so a status-only diff would treat the rogue edit as
 * pre-existing user WIP. Hashing the content closes that gap.
 */
function gitStatusSnapshot(cwd: string): Map<string, StatusEntry> {
  const r = git(['status', '--porcelain'], cwd)
  const map = new Map<string, StatusEntry>()
  if (r.status !== 0) return map
  for (const line of r.stdout.split('\n')) {
    if (!line) continue
    // Porcelain v1 format: two status chars, one space, then the path.
    // Renames appear as `R  old -> new`; we leave that string intact -
    // hashing will fail (no such file), the entry still produces a
    // distinct identity, and any rename through the planner shows up
    // as a rogue change.
    const status = line.slice(0, 2)
    const path = line.slice(3)
    map.set(path, { status, hash: hashFileSafe(join(cwd, path)) })
  }
  return map
}

function hashFileSafe(absPath: string): string {
  try {
    const content = readFileSync(absPath)
    return createHash('sha256').update(content).digest('hex')
  }
  catch {
    // File may have been deleted (status "D"), be a directory, or be a
    // rename-arrow path. An empty hash makes the entry compare distinct
    // from any concrete file's hash, which is the right default.
    return ''
  }
}

/**
 * Compare the post-planner git status against the snapshot taken before
 * invocation and return any path whose status OR content changed AND is
 * not the allowed planner-output file. Catches: planner edited a clean
 * file (status change), planner created a new file (new entry), and
 * planner re-edited a file the user had already dirtied (same status,
 * different content hash).
 */
function unauthorizedChanges(cwd: string, before: Map<string, StatusEntry>): string[] {
  const after = gitStatusSnapshot(cwd)
  const rogue: string[] = []
  for (const [path, entry] of after) {
    if (path === PLAN_OUTPUT_RELATIVE_PATH) continue
    const prior = before.get(path)
    if (prior && prior.status === entry.status && prior.hash === entry.hash) continue
    rogue.push(path)
  }
  return rogue
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
