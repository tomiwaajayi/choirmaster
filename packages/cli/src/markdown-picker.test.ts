import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { pickMarkdownFile } from './markdown-picker.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('pickMarkdownFile', () => {
  it('fails cleanly in non-interactive environments', async () => {
    const root = setupRepo({ 'docs/example.md': '# Example\n' })

    await expect(pickMarkdownFile({ cwd: root })).resolves.toEqual({
      ok: false,
      code: 64,
      message: 'No markdown file was selected. Pass <plan.md>, pass an exact @reference, or run this command in an interactive terminal.',
    })
  })

  it('reports when no markdown files exist', async () => {
    const root = setupRepo()

    await expect(pickMarkdownFile({ cwd: root })).resolves.toEqual({
      ok: false,
      code: 1,
      message: 'No markdown files found in this repo. Create one with `cm draft "your goal"` or pass an explicit plan path.',
    })
  })
})

function setupRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-picker-'))
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
