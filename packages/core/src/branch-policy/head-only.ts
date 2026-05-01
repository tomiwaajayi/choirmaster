/**
 * `headOnly`: every task fast-forwards into the project's current head
 * branch on completion. The worktree forks from head into a transient
 * branch (because git requires one) and the resulting commit is merged
 * back with `--ff-only`, leaving no merge commit and no per-task branch
 * in the visible history.
 *
 * Best for: small sequential tasks where you don't want a per-task branch
 * cluttering history.
 */

import type { BranchPolicy, CompletionOutcome, Task } from '../types.js'
import { resolveCurrentHead, tryMerge } from './_common.js'

export function headOnly(): BranchPolicy {
  return {
    name: 'head-only',
    resolveBase(projectRoot: string) {
      return resolveCurrentHead(projectRoot)
    },
    async onTaskCompleted(projectRoot: string, task: Task): Promise<CompletionOutcome> {
      const baseRef = task.base_ref
      if (!baseRef) {
        return { kind: 'failed', reason: 'task.base_ref missing; cannot ff-merge' }
      }
      const result = tryMerge(projectRoot, task.branch, { ffOnly: true, message: '' })
      if (!result.ok) {
        return { kind: 'conflict', into: baseRef, details: result.details ?? '' }
      }
      return { kind: 'merged', into: baseRef, sha: result.sha ?? '' }
    },
  }
}
