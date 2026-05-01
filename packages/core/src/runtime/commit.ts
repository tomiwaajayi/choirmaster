/**
 * Commit the implementer's work in the worktree. Stages everything (the
 * scope check has already run, so the diff is known-clean), creates a
 * commit with a structured message, and returns the commit SHA so the
 * branch policy can take over.
 *
 * Takes the SandboxHandle directly so non-worktree sandboxes (e.g. Docker
 * with a bind-mounted worktree at a different cwd) commit in the right
 * place without the caller reconstructing the path from task.worktree.
 */

import { git, revParse } from './git.js'
import type { SandboxHandle, Task } from '../types.js'

export interface CommitOptions {
  /** Optional summary text added under the commit subject. */
  summary?: string
  /** Override commit subject. Default: `${task.id}: ${task.title}`. */
  subject?: string
  /** Override author identity. Default: inherit from the user's git config. */
  author?: { name: string, email: string }
}

export function commitWorktree(
  task: Task,
  handle: SandboxHandle,
  options: CommitOptions = {},
): string {
  const cwd = handle.cwd

  const stageResult = git(['add', '-A'], cwd)
  if (stageResult.status !== 0) {
    throw new Error(`git add failed: ${stageResult.stderr.trim()}`)
  }

  const subject = options.subject ?? `${task.id}: ${task.title}`

  const args: string[] = []
  if (options.author) {
    args.push('-c', `user.name=${options.author.name}`, '-c', `user.email=${options.author.email}`)
  }
  args.push('commit', '-m', subject)
  if (options.summary && options.summary.trim()) {
    args.push('-m', options.summary.trim())
  }

  const commitResult = git(args, cwd)
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr.trim() || commitResult.stdout.trim()}`)
  }

  const sha = revParse('HEAD', cwd)
  if (!sha) {
    throw new Error('Commit succeeded but HEAD did not resolve to a SHA.')
  }
  return sha
}
