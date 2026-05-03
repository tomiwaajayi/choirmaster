import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { completeInteractiveLine, parseInteractiveLine } from './interactive.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('parseInteractiveLine', () => {
  it('parses slash commands with quoted args', () => {
    expect(parseInteractiveLine('/draft "add email sharing" --interactive')).toEqual({
      kind: 'command',
      command: '/draft',
      args: ['add email sharing', '--interactive'],
    })
  })

  it('requires slash commands', () => {
    expect(parseInteractiveLine('run @example')).toEqual({
      kind: 'error',
      message: 'Start interactive commands with /. Type /help.',
    })
  })
})

describe('completeInteractiveLine', () => {
  it('completes slash commands', () => {
    expect(completeInteractiveLine('/r', process.cwd())).toEqual([
      ['/run', '/resume'],
      '/r',
    ])
  })

  it('completes markdown references inside commands', () => {
    const root = setupRepo({
      '.choirmaster/plans/example.md': '# Example\n',
      '.choirmaster/prompts/planner.md': '# Prompt\n',
    })

    expect(completeInteractiveLine('/run @ex', root)).toEqual([
      ['@.choirmaster/plans/example.md'],
      '@ex',
    ])
  })
})

function setupRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-interactive-'))
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
