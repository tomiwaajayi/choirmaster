/**
 * Default ChoirMaster sandbox: a git worktree on the host. Cheap, fast, no
 * container overhead. Each task gets its own branch and its own checkout
 * directory; agents operate inside that directory and the orchestrator can
 * inspect, diff, and (eventually) clean up independently.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { git } from '../runtime/git.js'
import type { Sandbox, SandboxHandle, Task } from '../types.js'

export interface WorktreeSandboxOptions {
  /**
   * Allow reusing an existing worktree at `task.worktree`. Useful when
   * resuming a paused task; refuses by default to surface stale state.
   */
  allowReuse?: boolean
}

export function worktreeSandbox(options: WorktreeSandboxOptions = {}): Sandbox {
  return {
    name: 'worktree',
    async setup(task: Task, projectRoot: string): Promise<SandboxHandle> {
      if (!task.base_ref) {
        throw new Error(
          'worktreeSandbox: task.base_ref is required. The orchestration loop '
          + 'must call BranchPolicy.resolveBase and assign base_ref/base_sha to '
          + 'the task before invoking Sandbox.setup.',
        )
      }
      const worktreePath = join(projectRoot, task.worktree)

      if (existsSync(worktreePath)) {
        if (!options.allowReuse) {
          throw new Error(
            `Worktree already exists at ${task.worktree}. Pass allowReuse: true `
            + `or remove it with \`git worktree remove ${task.worktree}\`.`,
          )
        }
        return { cwd: worktreePath, worktreePath }
      }

      const result = git(
        ['worktree', 'add', task.worktree, '-b', task.branch, task.base_ref],
        projectRoot,
      )
      if (result.status !== 0) {
        throw new Error(`git worktree add failed: ${result.stderr.trim() || result.stdout.trim()}`)
      }

      return { cwd: worktreePath, worktreePath }
    },
  }
}
