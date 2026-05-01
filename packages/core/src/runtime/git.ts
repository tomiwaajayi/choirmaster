/**
 * Thin git command wrappers used across the runtime. All synchronous because
 * git operations are cheap and easier to reason about that way; the heavyweight
 * async work (agent turns, gate commands) goes through dedicated helpers.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process'

export interface GitResult {
  status: number | null
  stdout: string
  stderr: string
}

export function git(args: string[], cwd: string): GitResult {
  const result: SpawnSyncReturns<string> = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/**
 * Returns the abbreviated branch name, or `null` if HEAD is detached.
 * The runtime refuses to operate on a detached HEAD because base_ref
 * tracking would be meaningless.
 */
export function currentBranch(cwd: string): string | null {
  const r = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (r.status !== 0) return null
  const branch = r.stdout.trim()
  return branch === 'HEAD' || branch === '' ? null : branch
}

export function revParse(ref: string, cwd: string): string | null {
  const r = git(['rev-parse', ref], cwd)
  return r.status === 0 ? r.stdout.trim() : null
}

/**
 * Status check that ignores ChoirMaster's own bookkeeping. The runtime
 * mutates run-local state files as it works; those changes should not
 * count as "dirty user code".
 */
export function isCleanTree(
  repoRoot: string,
  ignorePathPrefixes: string[] = [],
): { clean: boolean; dirty: string[] } {
  const status = git(['status', '--porcelain'], repoRoot)
  const dirty = status.stdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((path) => {
      if (!path) return false
      return !ignorePathPrefixes.some(
        (prefix) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`),
      )
    })
  return { clean: dirty.length === 0, dirty }
}

/**
 * Lists files changed in `<base>...HEAD` for the worktree. Used for scope
 * checking after an agent turn.
 */
export function getChangedFiles(worktreeCwd: string, baseSha: string): string[] {
  const r = git(['diff', '--name-only', `${baseSha}...HEAD`], worktreeCwd)
  if (r.status !== 0) return []
  return r.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Captures both committed and uncommitted changes in a worktree as a single
 * unified diff. Used to preserve forensic context before reverting on a scope
 * violation.
 */
export function captureFullDiff(worktreeCwd: string, baseSha: string): string {
  const committed = git(['diff', `${baseSha}...HEAD`], worktreeCwd).stdout
  const uncommitted = git(['diff'], worktreeCwd).stdout
  const untracked = git(['ls-files', '--others', '--exclude-standard'], worktreeCwd).stdout
  return [
    `# Committed (${baseSha.slice(0, 8)}...HEAD)`,
    committed,
    '',
    '# Uncommitted',
    uncommitted,
    '',
    '# Untracked',
    untracked,
  ].join('\n')
}

/** Hard-resets and cleans a worktree. Used when scope enforcement triggers. */
export function revertWorktree(worktreeCwd: string): void {
  git(['reset', '--hard', 'HEAD'], worktreeCwd)
  git(['clean', '-fdx'], worktreeCwd)
}
