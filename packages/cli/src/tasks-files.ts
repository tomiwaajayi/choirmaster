/**
 * Discovery + completion for generated task contracts (`*.tasks.json`).
 *
 * Mirror of markdown-ref.ts but scoped to `.choirmaster/tasks/` (the
 * planner's output directory). Used by the interactive shell so `/run`
 * can suggest the contracts the user has reviewed via `/plan`,
 * complementing the existing markdown completer.
 *
 * Contracts live under `.choirmaster/tasks/` regardless of where the
 * source markdown lived in the repo. They are typically gitignored, so
 * we walk the filesystem directly rather than relying on `git ls-files`.
 *
 * Cached identically to markdown-ref.ts: short TTL (so external
 * regeneration eventually shows up) plus explicit invalidation by the
 * shell after every dispatched command.
 */

import type { Dirent } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { findGitRoot } from './project-root.js'
import { stripAnsi } from './strip-ansi.js'

export interface TasksFile {
  /** Repo-relative path (forward slashes). */
  path: string
  /** Modified time in ms; the shell sorts newest first by this. */
  mtimeMs: number
}

interface CachedTasksFiles {
  files: TasksFile[]
  expiresAt: number
}

const CACHE_TTL_MS = 2000
const tasksFilesCache = new Map<string, CachedTasksFiles>()

export function listTasksFiles(cwd: string): TasksFile[] {
  const repoRoot = findGitRoot(cwd)
  if (!repoRoot) return []

  const now = Date.now()
  const cached = tasksFilesCache.get(repoRoot)
  if (cached && cached.expiresAt > now) return cached.files

  const tasksRoot = join(repoRoot, '.choirmaster/tasks')
  const found: TasksFile[] = []
  walkTasksDir(tasksRoot, repoRoot, found)
  // Newest first. The freshly-planned contract is almost always the one
  // the user wants to /run next.
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  tasksFilesCache.set(repoRoot, { files: found, expiresAt: now + CACHE_TTL_MS })
  return found
}

export function searchTasksFiles(queryInput: string, cwd: string, limit = 50): TasksFile[] {
  const query = queryInput.replace(/^@/, '').trim().toLowerCase()
  const files = listTasksFiles(cwd)
  if (!query) return files.slice(0, limit)
  return files.filter((file) => matchesQuery(file.path, query)).slice(0, limit)
}

/**
 * Returns `@`-prefixed completion strings for `/run`. Mirrors the
 * shape of `completeMarkdownReferences` so the suggestion engine can
 * treat both result sets the same way.
 */
export function completeTasksJsonReferences(input: string, cwd: string): string[] {
  if (!input.startsWith('@')) return []
  const matches = searchTasksFiles(input, cwd, 50)
  return matches.map((file) => `@${file.path.replace(/[\n\r]/g, '')}`)
}

/**
 * Drop the tasks-files cache. Pairs with `invalidateMarkdownFilesCache`
 * in the shell's post-dispatch cleanup so a freshly-written contract
 * shows up immediately in the next suggestion list.
 */
export function invalidateTasksFilesCache(cwd?: string): void {
  if (cwd === undefined) {
    tasksFilesCache.clear()
    return
  }
  const repoRoot = findGitRoot(cwd)
  if (repoRoot) tasksFilesCache.delete(repoRoot)
}

function walkTasksDir(dir: string, repoRoot: string, out: TasksFile[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return
  }
  for (const entry of entries) {
    // Skip the planner's tmp scratch dir and any other dotfile dirs.
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkTasksDir(full, repoRoot, out)
      continue
    }
    if (!entry.isFile()) continue
    if (!entry.name.toLowerCase().endsWith('.tasks.json')) continue
    let mtimeMs = 0
    try {
      mtimeMs = statSync(full).mtimeMs
    }
    catch {
      continue
    }
    const rel = relative(repoRoot, full).split(sep).join('/')
    out.push({ path: stripAnsi(rel), mtimeMs })
  }
}

function matchesQuery(path: string, query: string): boolean {
  const lowerPath = path.toLowerCase()
  // Match against the full repo-relative path AND the basename without
  // the .tasks.json suffix, so `/run @example` finds
  // `.choirmaster/tasks/example.tasks.json`.
  if (lowerPath.includes(query)) return true
  const basename = lowerPath.split('/').pop() ?? ''
  const stem = basename.endsWith('.tasks.json') ? basename.slice(0, -'.tasks.json'.length) : basename
  return stem.includes(query)
}
