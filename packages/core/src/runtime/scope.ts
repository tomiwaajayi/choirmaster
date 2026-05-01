/**
 * Scope enforcement: every file the implementer touched must match an
 * `allowed_paths` glob and must NOT match any `forbidden_paths` glob. The
 * project's global `forbiddenPaths` is unioned with the per-task list.
 */

import type { Task } from '../types.js'

export interface ScopeViolation {
  file: string
  kind: 'not_allowed' | 'forbidden'
  /** The glob that triggered the violation, when the kind is 'forbidden'. */
  matchedForbidden?: string
}

export interface ScopeCheckInput {
  changedFiles: string[]
  allowedPaths: string[]
  forbiddenPaths: string[]
}

export function checkScope(input: ScopeCheckInput): ScopeViolation[] {
  const violations: ScopeViolation[] = []
  for (const file of input.changedFiles) {
    const forbiddenMatch = input.forbiddenPaths.find((g) => matchesGlob(file, g))
    if (forbiddenMatch) {
      violations.push({ file, kind: 'forbidden', matchedForbidden: forbiddenMatch })
      continue
    }
    if (!input.allowedPaths.some((g) => matchesGlob(file, g))) {
      violations.push({ file, kind: 'not_allowed' })
    }
  }
  return violations
}

/**
 * Convenience: build the effective forbidden+allowed lists for a task by
 * unioning the task's lists with the project's global `forbiddenPaths`.
 */
export function effectiveScope(
  task: Task,
  projectForbiddenPaths: string[] = [],
): { allowed: string[]; forbidden: string[] } {
  return {
    allowed: task.allowed_paths,
    forbidden: [...new Set([...projectForbiddenPaths, ...task.forbidden_paths])],
  }
}

/**
 * Minimal glob matcher.
 *
 * Supported forms:
 *   `literal/path.ts`           - exact match
 *   `app/*.vue`                 - one segment wildcard
 *   `app/**`                    - any depth under `app/` (and `app` itself)
 *   `app/**\/*.vue`             - any vue file under `app/` at any depth
 *   `**\/*.vue`                 - any vue file anywhere
 *
 * No brace expansion, no negation, no character classes. Sufficient for the
 * path patterns task contracts use; the runtime keeps the regex-from-glob
 * conversion explicit so the behaviour is predictable.
 */
function matchesGlob(path: string, glob: string): boolean {
  if (glob === path) return true

  // `prefix/**` matches `prefix` itself or anything under `prefix/`.
  if (glob.endsWith('/**')) {
    const prefix = glob.slice(0, -3)
    if (path === prefix) return true
    return path.startsWith(`${prefix}/`)
  }

  // `**/suffix` matches if any tail of the path matches `suffix`.
  if (glob.startsWith('**/')) {
    const suffix = glob.slice(3)
    if (matchesGlob(path, suffix)) return true
    const slashIdx = path.indexOf('/')
    if (slashIdx === -1) return false
    return matchesGlob(path.slice(slashIdx + 1), glob)
  }

  // `before/**\/after` matches `before/after` (** = empty), and any
  // intermediate-segment expansion.
  const middleIdx = glob.indexOf('/**/')
  if (middleIdx !== -1) {
    const before = glob.slice(0, middleIdx)
    const after = glob.slice(middleIdx + 4)
    if (matchesGlob(path, `${before}/${after}`)) return true
    if (!path.startsWith(`${before}/`)) return false
    const remaining = path.slice(before.length + 1)
    const nextSlash = remaining.indexOf('/')
    if (nextSlash === -1) return false
    return matchesGlob(`${before}/${remaining.slice(nextSlash + 1)}`, glob)
  }

  // No globstar: single-segment wildcards only. Convert to regex.
  const pattern = glob
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  return new RegExp(`^${pattern}$`).test(path)
}

// Exported only for testing.
export const __test = { matchesGlob }
