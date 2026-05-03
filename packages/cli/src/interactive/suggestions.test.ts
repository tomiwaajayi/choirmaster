import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { computeSuggestions, filterSlashCommands, tokenUnderCursor } from './suggestions.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('tokenUnderCursor', () => {
  it('returns null when cursor is on whitespace', () => {
    expect(tokenUnderCursor('/run ', 5)).toBeNull()
  })

  it('finds the slash token at the start of the line', () => {
    expect(tokenUnderCursor('/r', 2)).toEqual({ kind: '/', token: '/r', start: 0 })
  })

  it('finds the @-token after a space', () => {
    expect(tokenUnderCursor('/run @ex', 8)).toEqual({ kind: '@', token: '@ex', start: 5 })
  })

  it('returns null inside a plain word', () => {
    expect(tokenUnderCursor('/run example', 12)).toBeNull()
  })
})

describe('filterSlashCommands', () => {
  it('filters commands by prefix and surfaces hints', () => {
    const result = filterSlashCommands('/r')
    expect(result.map((s) => s.value)).toEqual(['/run', '/resume'])
    expect(result[0]!.hint).toBeTruthy()
  })

  it('returns the full command list for a bare slash', () => {
    expect(filterSlashCommands('/').map((s) => s.value)).toContain('/help')
  })
})

describe('computeSuggestions', () => {
  it('opens slash suggestions only at the start of the line', () => {
    const result = computeSuggestions('/r', 2, process.cwd())
    expect(result?.kind).toBe('slash')
    expect(result?.items.map((s) => s.value)).toEqual(['/run', '/resume'])
  })

  it('does not re-open slash list after the first token', () => {
    expect(computeSuggestions('/run /h', 7, process.cwd())).toBeNull()
  })

  it('opens markdown suggestions inside /run after @', () => {
    const root = setupRepo({
      '.choirmaster/plans/example.md': '# Example\n',
    })
    const result = computeSuggestions('/run @ex', 8, root)
    expect(result?.kind).toBe('markdown')
    expect(result?.items.map((s) => s.value)).toEqual(['@.choirmaster/plans/example.md'])
  })

  it('refuses markdown suggestions for /doctor', () => {
    expect(computeSuggestions('/doctor @ex', 11, process.cwd())).toBeNull()
  })

  it('refuses markdown suggestions for /draft (it does not resolve @-references)', () => {
    const root = setupRepo({
      '.choirmaster/plans/example.md': '# Example\n',
    })
    expect(computeSuggestions('/draft @ex', 10, root)).toBeNull()
  })

  it('still suggests slash commands for /d-prefix even though /draft has no @ support', () => {
    const result = computeSuggestions('/d', 2, process.cwd())
    expect(result?.kind).toBe('slash')
    expect(result?.items.map((s) => s.value)).toContain('/draft')
    expect(result?.items.map((s) => s.value)).toContain('/doctor')
  })

  it('ignores leading whitespace when finding the first token', () => {
    const result = computeSuggestions('  /r', 4, process.cwd())
    expect(result?.kind).toBe('slash')
    expect(result?.items.map((s) => s.value)).toEqual(['/run', '/resume'])
  })
})

function setupRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-suggest-'))
  roots.push(root)
  sh('git init -b main', root)
  sh('git config user.email test@example.com', root)
  sh('git config user.name "Test"', root)
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  sh('git add -A && git commit -m initial --allow-empty', root)
  return root
}

function sh(command: string, cwd: string): void {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr || result.stdout}`)
  }
}
