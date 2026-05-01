/**
 * Deterministic gate runner. Runs each `GateConfig.command` in the worktree,
 * captures stdout/stderr, returns structured results. Failures are not
 * thrown; the caller decides whether to route back to the implementer or
 * fail the task.
 */

import { spawnSync } from 'node:child_process'

import type { GateConfig, GateResult } from '../types.js'

export interface RunGatesResult {
  ok: boolean
  results: GateResult[]
}

export function runGates(gates: GateConfig[], cwd: string): RunGatesResult {
  const results: GateResult[] = []
  for (const gate of gates) {
    results.push(runOne(gate, cwd))
  }
  return { ok: results.every((r) => r.ok), results }
}

function runOne(gate: GateConfig, cwd: string): GateResult {
  const t0 = Date.now()
  const r = spawnSync(gate.command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    name: gate.name,
    ok: r.status === 0,
    exitCode: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    durationMs: Date.now() - t0,
  }
}

/**
 * Render gate results into a single block of text the runtime can hand back
 * to the implementer as a "fix this" prompt. Truncates per-stream to keep
 * the prompt within reasonable size.
 */
export function summariseFailures(results: GateResult[]): string {
  const lines: string[] = []
  for (const r of results) {
    const status = r.ok ? 'pass' : 'FAIL'
    lines.push(`### ${r.name} - ${status} (exit ${r.exitCode}, ${r.durationMs}ms)`)
    if (!r.ok) {
      const stdout = r.stdout.slice(-4000).trim()
      const stderr = r.stderr.slice(-4000).trim()
      if (stdout) {
        lines.push('')
        lines.push('stdout:')
        lines.push('```')
        lines.push(stdout)
        lines.push('```')
      }
      if (stderr) {
        lines.push('')
        lines.push('stderr:')
        lines.push('```')
        lines.push(stderr)
        lines.push('```')
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}
