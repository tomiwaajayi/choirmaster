/**
 * `choirmaster plan <plan.md|@query> [--output <tasks.json>]`
 *
 * Decompose a markdown plan into a validated `*.tasks.json` contract.
 * The runtime helper does the work; this command just wires args, manifest,
 * and stdout/stderr formatting.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'

import { runPlanner, type RunPlannerResult } from '@choirmaster/core'

import { formatMarkdownReferenceError, resolveMarkdownReference } from '../markdown-ref.js'
import { loadManifest } from '../manifest.js'
import { resolveProjectRoot } from '../project-root.js'

export interface PlanCommandArgs {
  /** Path to the markdown plan (relative or absolute), or @query shorthand. */
  planFile: string
  /** Optional override for the generated tasks.json path. */
  outputFile?: string
  /** Allow overwriting an existing tasks file at the output path. */
  force?: boolean
  /** Working directory; defaults to process.cwd(). */
  cwd?: string
}

export async function planCommand(args: PlanCommandArgs): Promise<number> {
  const projectRoot = resolveProjectRoot(args.cwd ?? process.cwd())

  let config
  try {
    config = await loadManifest(projectRoot)
  }
  catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }

  const planRef = resolveMarkdownReference(args.planFile, projectRoot)
  if (!planRef.ok) {
    process.stderr.write(formatMarkdownReferenceError(planRef))
    return 64
  }

  const planFile = planRef.path
  const planPath = resolve(projectRoot, planFile)
  if (!existsSync(planPath)) {
    process.stderr.write(`plan file not found: ${planPath}\n`)
    return 1
  }
  if (extname(planPath).toLowerCase() !== '.md') {
    process.stderr.write(`plan file must be a markdown (.md) file: ${planFile}\n`)
    return 64
  }

  const outputPath = args.outputFile
    ? resolve(projectRoot, args.outputFile)
    : defaultTasksOutputPath(planPath, projectRoot)

  // Per-run logs for the planner are noisy and we don't yet have a run
  // directory to file them under. The agent's stream still surfaces in
  // stdout via the helper's event handler.
  const logsDir = resolve(projectRoot, '.choirmaster/logs')
  mkdirSync(logsDir, { recursive: true })

  process.stdout.write(`\nChoirMaster plan ${planFile}\n`)
  process.stdout.write(`  agent: ${config.agents.planner.name}\n`)
  process.stdout.write(`  output: ${shortPath(outputPath, projectRoot)}\n\n`)
  if (!isInsideProject(outputPath, projectRoot)) {
    process.stdout.write(`Warning: output is outside the project root; @ shortcuts only match markdown files inside the repo.\n\n`)
  }

  const result: RunPlannerResult = await runPlanner(
    {
      projectRoot,
      runDir: resolve(projectRoot, '.choirmaster'),
      logsDir,
      config,
    },
    { planPath, outputPath, force: args.force ?? false },
  )

  if (!result.ok) {
    process.stderr.write(`\nPlanner failed:\n`)
    for (const e of result.errors) {
      process.stderr.write(`  - ${e}\n`)
    }
    if (result.rawOutputPath) {
      process.stderr.write(
        `\nRaw planner output preserved at ${shortPath(result.rawOutputPath, projectRoot)} for debugging.\n`,
      )
    }
    if (result.capacityHit) return 3
    return 2
  }

  process.stdout.write(
    `\nPlan generated: ${result.tasksGenerated} task(s) -> ${shortPath(result.outputPath, projectRoot)}\n`,
  )
  process.stdout.write(`Run with: choirmaster run ${shortPath(result.outputPath, projectRoot)}\n\n`)
  return 0
}

/**
 * Default task contracts live under `.choirmaster/tasks/`, keeping human
 * markdown plans separate from generated runtime contracts:
 *
 * - `.choirmaster/plans/example.md` -> `.choirmaster/tasks/example.tasks.json`
 * - `docs/migration.md` -> `.choirmaster/tasks/docs/migration.tasks.json`
 */
export function defaultTasksOutputPath(planPath: string, projectRoot: string): string {
  const projectAbs = resolve(projectRoot)
  const planAbs = resolve(planPath)
  const rel = relative(projectAbs, planAbs)
  const planRel = rel && !rel.startsWith('..') && !isAbsolute(rel)
    ? rel.split(sep).join('/')
    : basename(planAbs)

  const contractRel = planRel.startsWith('.choirmaster/plans/')
    ? planRel.slice('.choirmaster/plans/'.length)
    : planRel
  const ext = extname(contractRel)
  const withoutExt = ext ? contractRel.slice(0, -ext.length) : contractRel
  return resolve(projectAbs, '.choirmaster/tasks', `${withoutExt}.tasks.json`)
}

function shortPath(absPath: string, projectRoot: string): string {
  const relPrefix = `${projectRoot}/`
  return absPath.startsWith(relPrefix) ? absPath.slice(relPrefix.length) : absPath
}

function isInsideProject(absPath: string, projectRoot: string): boolean {
  return absPath === projectRoot || absPath.startsWith(`${projectRoot}/`)
}
