/**
 * `perTaskBranch`: each task commits on its own branch and the orchestrator
 * leaves it there. No merge happens. You inspect each branch and merge or
 * open PRs manually.
 *
 * Best for: review-heavy workflows where every task needs human eyes
 * before landing.
 */

import type { BranchPolicy, CompletionOutcome, Task } from '../types.js'
import { resolveCurrentHead } from './_common.js'

export function perTaskBranch(): BranchPolicy {
  return {
    name: 'per-task-branch',
    resolveBase(projectRoot: string) {
      return resolveCurrentHead(projectRoot)
    },
    async onTaskCompleted(_projectRoot: string, task: Task): Promise<CompletionOutcome> {
      return {
        kind: 'left-on-branch',
        branch: task.branch,
        sha: task.commit ?? '',
      }
    },
  }
}
