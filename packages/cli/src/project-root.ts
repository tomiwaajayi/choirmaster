import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

export function findGitRoot(cwd: string): string | null {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
  })
  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

export function resolveProjectRoot(cwd: string): string {
  return findGitRoot(cwd) ?? resolve(cwd)
}
