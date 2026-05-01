/**
 * Default ChoirMaster sandbox: a git worktree on the host. Cheap, fast, no
 * container overhead. Each task gets its own branch and its own checkout
 * directory; agents operate inside that directory and the orchestrator can
 * inspect, diff, and (eventually) clean up independently.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { git } from '../runtime/git.js'
import type { Sandbox, SandboxHandle, SandboxSetupOptions, Task } from '../types.js'

export interface WorktreeSandboxOptions {
  /**
   * Default for `allowReuse` when the runtime doesn't pass an explicit
   * setup-time value. The runtime overrides this on capacity resume so
   * paused worktrees aren't rejected mid-run.
   */
  allowReuse?: boolean
}

export function worktreeSandbox(factoryOptions: WorktreeSandboxOptions = {}): Sandbox {
  return {
    name: 'worktree',
    async setup(task: Task, projectRoot: string, options?: SandboxSetupOptions): Promise<SandboxHandle> {
      if (!task.base_ref) {
        throw new Error(
          'worktreeSandbox: task.base_ref is required. The runtime must '
          + 'resolve and assign base_ref/base_sha before calling Sandbox.setup.',
        )
      }
      const worktreePath = join(projectRoot, task.worktree)
      const allowReuse = options?.allowReuse ?? factoryOptions.allowReuse ?? false

      if (existsSync(worktreePath)) {
        if (!allowReuse) {
          throw new Error(
            `Worktree already exists at ${task.worktree}. Pass --reuse-worktree, `
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
