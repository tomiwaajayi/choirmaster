import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  completeMarkdownReferences,
  formatMarkdownReferenceError,
  invalidateMarkdownFilesCache,
  resolveMarkdownReference,
} from './markdown-ref.js'

const roots: string[] = []

beforeEach(() => {
  invalidateMarkdownFilesCache()
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  invalidateMarkdownFilesCache()
})

describe('resolveMarkdownReference', () => {
  it('leaves normal paths untouched', () => {
    const root = setupRepo()

    expect(resolveMarkdownReference('.choirmaster/plans/example.md', root)).toEqual({
      ok: true,
      path: '.choirmaster/plans/example.md',
      matched: false,
    })
  })

  it('matches a tracked markdown file by basename without extension', () => {
    const root = setupRepo({
      files: {
        '.choirmaster/plans/example.md': '# Example\n',
        'docs/roadmap.md': '# Roadmap\n',
      },
      commit: true,
    })

    expect(resolveMarkdownReference('@example', root)).toEqual({
      ok: true,
      path: '.choirmaster/plans/example.md',
      matched: true,
    })
  })

  it('matches an explicit markdown path with or without the extension', () => {
    const root = setupRepo({
      files: {
        'docs/dashboard-state-machine.md': '# Dashboard\n',
      },
      commit: true,
    })

    expect(resolveMarkdownReference('@docs/dashboard-state-machine.md', root)).toEqual({
      ok: true,
      path: 'docs/dashboard-state-machine.md',
      matched: true,
    })
    expect(resolveMarkdownReference('@docs/dashboard-state-machine', root)).toEqual({
      ok: true,
      path: 'docs/dashboard-state-machine.md',
      matched: true,
    })
  })

  it('matches repo markdown files when called from a subdirectory', () => {
    const root = setupRepo({
      files: {
        '.choirmaster/plans/example.md': '# Example\n',
        'packages/cli/README.md': '# CLI\n',
      },
      commit: true,
    })
    const subdir = join(root, 'packages/cli')

    expect(resolveMarkdownReference('@example', subdir)).toEqual({
      ok: true,
      path: '.choirmaster/plans/example.md',
      matched: true,
    })
    expect(completeMarkdownReferences('@example', subdir)).toEqual(['@.choirmaster/plans/example.md'])
  })

  it('matches untracked markdown files too', () => {
    const root = setupRepo({
      files: {
        'scratch/new-plan.md': '# New plan\n',
      },
      commit: false,
    })

    expect(resolveMarkdownReference('@new-plan', root)).toEqual({
      ok: true,
      path: 'scratch/new-plan.md',
      matched: true,
    })
  })

  it('is case-insensitive', () => {
    const root = setupRepo({
      files: {
        'Plans/Release-Plan.md': '# Release\n',
      },
      commit: true,
    })

    expect(resolveMarkdownReference('@release-plan', root)).toEqual({
      ok: true,
      path: 'Plans/Release-Plan.md',
      matched: true,
    })
  })

  it('returns suggestions when an exact basename is ambiguous', () => {
    const root = setupRepo({
      files: {
        '.choirmaster/plans/auth.md': '# Auth\n',
        'docs/auth.md': '# Auth docs\n',
        'notes/auth-rollout.md': '# Auth rollout\n',
      },
      commit: true,
    })

    const result = resolveMarkdownReference('@auth', root)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe('Multiple markdown files exactly match @auth. Choose one with shell completion, or pass the explicit markdown path.')
      expect(result.suggestions).toEqual([
        '.choirmaster/plans/auth.md',
        'docs/auth.md',
      ])
    }
  })

  it('does not execute-time resolve a fuzzy prefix to a single file', () => {
    const root = setupRepo({
      files: {
        'docs/dashboard-state-machine.md': '# Dashboard\n',
      },
      commit: true,
    })

    const result = resolveMarkdownReference('@dashboard', root)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe('@dashboard is not an exact markdown reference. Use shell completion to choose a file, or pass the explicit markdown path.')
      expect(result.suggestions).toEqual(['docs/dashboard-state-machine.md'])
    }
    expect(completeMarkdownReferences('@dashboard', root)).toEqual(['@docs/dashboard-state-machine.md'])
  })

  it('returns a helpful empty-query message with markdown suggestions', () => {
    const root = setupRepo({
      files: {
        '.choirmaster/plans/example.md': '# Example\n',
        'README.md': '# Readme\n',
      },
      commit: true,
    })

    const result = resolveMarkdownReference('@', root)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(formatMarkdownReferenceError(result)).toContain('Type some text after @ to match a markdown file.')
      expect(formatMarkdownReferenceError(result)).toContain('Markdown files in this repo:')
      expect(result.suggestions).toEqual(['.choirmaster/plans/example.md', 'README.md'])
    }
  })

  it('returns no suggestions when there are no matches', () => {
    const root = setupRepo({
      files: {
        'docs/roadmap.md': '# Roadmap\n',
      },
      commit: true,
    })

    const result = resolveMarkdownReference('@missing', root)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toBe('No markdown files match @missing.')
      expect(result.suggestions).toEqual([])
    }
  })

  it('ignores markdown files inside .choirmaster/runs', () => {
    const root = setupRepo({
      files: {
        '.choirmaster/plans/example.md': '# Example\n',
        '.choirmaster/runs/2026/log.md': '# Log\n',
      },
      commit: true,
    })

    expect(resolveMarkdownReference('@log', root)).toMatchObject({
      ok: false,
      suggestions: [],
    })
  })

  it('ignores internal prompt markdown files', () => {
    const root = setupRepo({
      files: {
        '.choirmaster/prompts/planner.md': '# Planner prompt\n',
      },
      commit: true,
    })

    expect(resolveMarkdownReference('@planner', root)).toMatchObject({
      ok: false,
      suggestions: [],
    })
  })

  it('returns completion candidates with @ prefixes', () => {
    const root = setupRepo({
      files: {
        '.choirmaster/plans/example.md': '# Example\n',
        'docs/roadmap.md': '# Roadmap\n',
        'notes/release.md': '# Release\n',
      },
      commit: true,
    })

    expect(completeMarkdownReferences('@ex', root)).toEqual(['@.choirmaster/plans/example.md'])
    expect(completeMarkdownReferences('@', root)).toEqual([
      '@.choirmaster/plans/example.md',
      '@docs/roadmap.md',
      '@notes/release.md',
    ])
  })

  it('does not complete non-reference inputs', () => {
    const root = setupRepo({
      files: {
        'docs/roadmap.md': '# Roadmap\n',
      },
      commit: true,
    })

    expect(completeMarkdownReferences('docs', root)).toEqual([])
  })
})

describe('markdown file cache', () => {
  it('returns stale results within the TTL until invalidated', () => {
    const root = setupRepo({
      files: { 'a.md': '# A\n' },
      commit: true,
    })
    expect(completeMarkdownReferences('@a', root)).toEqual(['@a.md'])

    // Add a new markdown file. Within the TTL the cached list does
    // not include it.
    writeFileSync(join(root, 'b.md'), '# B\n')
    expect(completeMarkdownReferences('@b', root)).toEqual([])

    // Invalidating the cache makes the next call rescan.
    invalidateMarkdownFilesCache(root)
    expect(completeMarkdownReferences('@b', root)).toEqual(['@b.md'])
  })

  it('respects the TTL: an expired entry is rebuilt without explicit invalidation', () => {
    const realDateNow = Date.now
    let now = 1_000_000
    Date.now = () => now
    try {
      const root = setupRepo({
        files: { 'a.md': '# A\n' },
        commit: true,
      })
      expect(completeMarkdownReferences('@a', root)).toEqual(['@a.md'])

      // Add a new file and advance "time" past the TTL window.
      writeFileSync(join(root, 'b.md'), '# B\n')
      now += 10_000

      // No explicit invalidation; the TTL alone should make the cache
      // rebuild and pick up the new file.
      expect(completeMarkdownReferences('@b', root)).toEqual(['@b.md'])
    }
    finally {
      Date.now = realDateNow
    }
  })

  it('strips ANSI escape sequences from filenames at the source', () => {
    const root = setupRepo({
      files: {
        // The CSI sequence here would clear the screen if rendered as-is.
        // The cache layer must scrub it before any consumer can see it.
        'evil\x1b[2Jname.md': '# Evil\n',
      },
      commit: true,
    })
    const matches = completeMarkdownReferences('@evil', root)
    expect(matches).toEqual(['@evilname.md'])
    expect(matches[0]).not.toContain('\x1b')
  })

  it('clears all entries when invalidated without an argument', () => {
    const rootA = setupRepo({ files: { 'doc.md': '# A\n' }, commit: true })
    const rootB = setupRepo({ files: { 'doc.md': '# B\n' }, commit: true })
    completeMarkdownReferences('@doc', rootA)
    completeMarkdownReferences('@doc', rootB)
    invalidateMarkdownFilesCache()
    // After global clear, both should still resolve correctly (rescan).
    expect(completeMarkdownReferences('@doc', rootA)).toEqual(['@doc.md'])
    expect(completeMarkdownReferences('@doc', rootB)).toEqual(['@doc.md'])
  })
})

function setupRepo({
  files = {},
  commit = false,
}: {
  files?: Record<string, string>
  commit?: boolean
} = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-md-ref-'))
  roots.push(root)
  sh('git init -b main', root)
  sh('git config user.email test@example.com', root)
  sh('git config user.name "Test"', root)

  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }

  if (commit) {
    sh('git add -A && git commit -m initial', root)
  }

  return root
}

function sh(command: string, cwd: string): void {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr || result.stdout}`)
  }
}
