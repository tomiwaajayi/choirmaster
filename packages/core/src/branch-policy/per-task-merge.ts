/**
 * `perTaskMerge`: each task gets its own branch (created at worktree time);
 * on completion, the orchestrator merges the branch back into the base
 * with `--no-ff` so the per-task history is preserved as a merge commit.
 *
 * This is the default for ChoirMaster: it's the proven shape from the
 * CoreHue migration where each task is reviewable as a single PR-shaped
 * unit but lands on the base branch automatically when checks pass.
 *
 * Best for: a chain of medium-sized tasks where each task should be
 * inspectable in history and the next task should fork from the latest
 * cumulative state.
 */

import type { BranchPolicy, CompletionOutcome, Task } from '../types.js'
import { tryMerge } from './_common.js'

export interface PerTaskMergeOptions {
  /**
   * Custom merge commit message builder. Default:
   *   `Merge ${task.id}: ${task.title}`
   */
  messageFor?: (task: Task) => string
}

export function perTaskMerge(options: PerTaskMergeOptions = {}): BranchPolicy {
  const buildMessage = options.messageFor
    ?? ((task: Task) => `Merge ${task.id}: ${task.title}`)

  return {
    name: 'per-task-merge',
    async onTaskCompleted(projectRoot: string, task: Task): Promise<CompletionOutcome> {
      const baseRef = task.base_ref
      if (!baseRef) {
        return { kind: 'failed', reason: 'task.base_ref missing; cannot merge' }
      }
      const result = tryMerge(projectRoot, task.branch, {
        ffOnly: false,
        message: buildMessage(task),
      })
      if (!result.ok) {
        return { kind: 'conflict', into: baseRef, details: result.details ?? '' }
      }
      return { kind: 'merged', into: baseRef, sha: result.sha ?? '' }
    },
  }
}
