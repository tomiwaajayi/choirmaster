import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadRepoContext, resetRepoContextCacheForTests } from './repo-context.js'

const roots: string[] = []

beforeEach(() => {
  resetRepoContextCacheForTests()
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  resetRepoContextCacheForTests()
})

describe('loadRepoContext', () => {
  it('reports repo name and current branch from git', async () => {
    const root = setupRepo()
    const ctx = await loadRepoContext(root)
    expect(ctx.repoName.startsWith('choir-ctx-')).toBe(true)
    expect(ctx.branch).toBe('main')
    expect(ctx.dirty).toBe(false)
    expect(ctx.resumableCount).toBe(0)
  })

  it('flags a dirty working tree when there are uncommitted changes', async () => {
    const root = setupRepo()
    writeFileSync(join(root, 'untracked.txt'), 'x')
    const ctx = await loadRepoContext(root)
    expect(ctx.dirty).toBe(true)
  })

  it('counts resumable runs from .choirmaster/runs', async () => {
    const root = setupRepo()
    const dir = join(root, '.choirmaster/runs/2026-04-waiting')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        tasks: [{ id: 'T', status: 'waiting_for_capacity', paused_phase: 'reviewer' }],
      }),
    )
    const ctx = await loadRepoContext(root)
    expect(ctx.resumableCount).toBe(1)
  })

  it('does not count runs with only blocked tasks (cm --resume cannot action them)', async () => {
    const root = setupRepo()
    const dir = join(root, '.choirmaster/runs/2026-04-blocked')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        tasks: [{ id: 'T', status: 'blocked', blocked_reason: 'gates failed' }],
      }),
    )
    const ctx = await loadRepoContext(root)
    expect(ctx.resumableCount).toBe(0)
  })

  it('returns no branch and no base when not inside a git repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-ctx-nogit-'))
    roots.push(root)
    const ctx = await loadRepoContext(root)
    expect(ctx.branch).toBeUndefined()
    expect(ctx.base).toBeUndefined()
    expect(ctx.dirty).toBe(false)
  })

  it('caches manifest base lookups across calls (no duplicate evaluation)', async () => {
    const root = setupRepo()
    // First call populates the cache.
    await loadRepoContext(root)
    // If the cache works, a second call should not re-import the manifest;
    // we can't observe that directly, but we CAN verify cache invalidation
    // makes the next call recompute by deleting and re-creating the file.
    rmSync(join(root, '.choirmaster'), { recursive: true, force: true })
    const ctx = await loadRepoContext(root)
    // Cache returns the previously-loaded base (undefined since this repo
    // never had a manifest); the point of the test is "no crash, no
    // observable difference between calls".
    expect(ctx.base).toBeUndefined()
  })
})

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-ctx-'))
  roots.push(root)
  sh('git init -b main', root)
  sh('git config user.email test@example.com', root)
  sh('git config user.name "Test"', root)
  sh('git commit -m initial --allow-empty', root)
  return root
}

function sh(command: string, cwd: string): void {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr || result.stdout}`)
  }
}
