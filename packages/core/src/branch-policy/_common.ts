/**
 * Shared helpers for the built-in BranchPolicy implementations. Internal
 * to the package; consumers use the named factories.
 */

import { currentBranch, git, revParse } from '../runtime/git.js'

export interface MergeAttemptOptions {
  ffOnly?: boolean
  message: string
}

export interface MergeAttemptResult {
  ok: boolean
  sha?: string
  details?: string
}

export function resolveCurrentHead(projectRoot: string): { ref: string, sha: string } {
  const ref = currentBranch(projectRoot)
  if (!ref) {
    throw new Error(
      'Cannot resolve base ref: the project root is on a detached HEAD. '
      + 'Check out a branch (e.g. `git checkout main`) before running.',
    )
  }
  const sha = revParse(ref, projectRoot)
  if (!sha) {
    throw new Error(`Cannot resolve SHA for ${ref}.`)
  }
  return { ref, sha }
}

export function tryMerge(
  projectRoot: string,
  branchToMerge: string,
  options: MergeAttemptOptions,
): MergeAttemptResult {
  const args = ['merge', options.ffOnly ? '--ff-only' : '--no-ff']
  if (!options.ffOnly) args.push('-m', options.message)
  args.push(branchToMerge)

  const result = git(args, projectRoot)
  if (result.status === 0) {
    const sha = revParse('HEAD', projectRoot)
    return { ok: true, sha: sha ?? '' }
  }

  // Abort to keep the base tree clean. Safe even if no merge is in progress.
  git(['merge', '--abort'], projectRoot)
  return {
    ok: false,
    details: (result.stderr || result.stdout || 'merge failed').trim().slice(0, 1000),
  }
}
