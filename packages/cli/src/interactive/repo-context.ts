/**
 * Repo context for the shell status header.
 *
 * Best-effort: a missing manifest, dirty `git`, or no resumable runs
 * never blocks the shell from opening. The header just shows what it
 * knows.
 *
 * The manifest is loaded by user-controlled code (a `.choirmaster/
 * manifest.ts` import), so we cache its base value per project root
 * for the lifetime of the shell. The dirty flag and resumable count
 * are cheap to recompute and intentionally not cached: those values
 * change while the user works.
 */

import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

import { findGitRoot, resolveProjectRoot } from '../project-root.js'

import { listResumableRuns } from './runs.js'

export interface RepoContext {
  repoName: string
  branch?: string
  base?: string
  dirty: boolean
  resumableCount: number
}

const manifestBaseCache = new Map<string, string | undefined>()

export async function loadRepoContext(cwd: string): Promise<RepoContext> {
  const projectRoot = resolveProjectRoot(cwd)
  const gitRoot = findGitRoot(cwd)

  const branch = gitRoot ? gitOutput(['rev-parse', '--abbrev-ref', 'HEAD'], gitRoot) : undefined
  const dirty = gitRoot ? !!gitOutput(['status', '--porcelain'], gitRoot) : false
  const base = await readManifestBaseCached(projectRoot)
  const resumableCount = listResumableRuns(projectRoot).length

  return {
    repoName: basename(projectRoot),
    branch: branch || undefined,
    base,
    dirty,
    resumableCount,
  }
}

/**
 * Test-only: drop the manifest base cache. The shell holds a cache
 * for the lifetime of its session; tests that mutate manifests across
 * cases need to invalidate it.
 */
export function resetRepoContextCacheForTests(): void {
  manifestBaseCache.clear()
}

function gitOutput(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) return ''
  return result.stdout.trim()
}

async function readManifestBaseCached(projectRoot: string): Promise<string | undefined> {
  if (manifestBaseCache.has(projectRoot)) {
    return manifestBaseCache.get(projectRoot)
  }
  const value = await readManifestBase(projectRoot)
  manifestBaseCache.set(projectRoot, value)
  return value
}

async function readManifestBase(projectRoot: string): Promise<string | undefined> {
  // Manifest loading runs user code; the shell shouldn't crash on a
  // broken manifest. Lazy-load and swallow any failure.
  try {
    const { loadManifest } = await import('../manifest.js')
    const config = await loadManifest(projectRoot)
    return config.base
  }
  catch {
    return undefined
  }
}
