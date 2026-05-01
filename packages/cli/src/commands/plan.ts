/**
 * `choirmaster plan <plan.md> [--output <tasks.json>]`
 *
 * Decompose a markdown plan into a validated `*.tasks.json` next to it.
 * The runtime helper does the work; this command just wires args, manifest,
 * and stdout/stderr formatting.
 */

import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'

import { runPlanner, type RunPlannerResult } from '@choirmaster/core'

import { loadManifest } from '../manifest.js'

export interface PlanCommandArgs {
  /** Path to the markdown plan (relative or absolute). */
  planFile: string
  /** Optional override for the generated tasks.json path. */
  outputFile?: string
  /** Working directory; defaults to process.cwd(). */
  cwd?: string
}

export async function planCommand(args: PlanCommandArgs): Promise<number> {
  const projectRoot = resolve(args.cwd ?? process.cwd())

  let config
  try {
    config = await loadManifest(projectRoot)
  }
  catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    return 1
  }

  const planPath = resolve(projectRoot, args.planFile)
  if (!existsSync(planPath)) {
    process.stderr.write(`plan file not found: ${planPath}\n`)
    return 1
  }
  if (extname(planPath).toLowerCase() !== '.md') {
    process.stderr.write(`plan file must be a markdown (.md) file: ${args.planFile}\n`)
    return 64
  }

  const outputPath = args.outputFile
    ? resolve(projectRoot, args.outputFile)
    : defaultOutputPath(planPath)

  // Per-run logs for the planner are noisy and we don't yet have a run
  // directory to file them under. The agent's stream still surfaces in
  // stdout via the helper's event handler.
  const logsDir = resolve(projectRoot, '.choirmaster/logs')
  mkdirSync(logsDir, { recursive: true })

  process.stdout.write(`\nChoirMaster plan ${args.planFile}\n`)
  process.stdout.write(`  agent: ${config.agents.planner.name}\n`)
  process.stdout.write(`  output: ${shortPath(outputPath, projectRoot)}\n\n`)

  const result: RunPlannerResult = await runPlanner(
    {
      projectRoot,
      runDir: resolve(projectRoot, '.choirmaster'),
      logsDir,
      config,
    },
    { planPath, outputPath },
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
 * `path/to/plan.md` -> `path/to/plan.tasks.json` (next to the input).
 */
function defaultOutputPath(planPath: string): string {
  const dir = dirname(planPath)
  const base = basename(planPath, extname(planPath))
  return resolve(dir, `${base}.tasks.json`)
}

function shortPath(absPath: string, projectRoot: string): string {
  const relPrefix = `${projectRoot}/`
  return absPath.startsWith(relPrefix) ? absPath.slice(relPrefix.length) : absPath
}
