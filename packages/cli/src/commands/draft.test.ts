import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { draftCommand } from './draft.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('draftCommand', () => {
  it('creates a markdown plan skeleton from a goal', async () => {
    const root = tempRoot()

    const { code, stdout } = await captureDraft({
      cwd: root,
      goal: 'migrate dashboard styles from scss to tailwind',
    })

    const path = join(root, '.choirmaster/plans/migrate-dashboard-styles-from-scss-to-tailwind.md')
    expect(code).toBe(0)
    expect(stdout).toContain('Draft plan created: .choirmaster/plans/migrate-dashboard-styles-from-scss-to-tailwind.md')
    expect(readFileSync(path, 'utf8')).toContain('# Plan: Migrate Dashboard Styles From Scss To Tailwind')
    expect(readFileSync(path, 'utf8')).toContain('## Clarifying Questions')
    expect(readFileSync(path, 'utf8')).toContain('Recommended default: use phased tasks')
  })

  it('creates a draft from source notes', async () => {
    const root = tempRoot()
    writeFileSync(join(root, 'notes.md'), '# Improve onboarding\n\nNeed better docs and checks.\n')

    const { code } = await captureDraft({ cwd: root, fromFile: 'notes.md' })

    const path = join(root, '.choirmaster/plans/improve-onboarding.md')
    expect(code).toBe(0)
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('# Plan: Improve onboarding')
    expect(content).toContain('Imported from `notes.md`')
    expect(content).toContain('Need better docs and checks.')
  })

  it('refuses to overwrite an existing draft unless forced', async () => {
    const root = tempRoot()
    const path = join(root, '.choirmaster/plans/add-notes.md')
    mkdirSync(join(root, '.choirmaster/plans'), { recursive: true })
    writeFileSync(path, 'keep me\n')

    const blocked = await captureDraft({ cwd: root, goal: 'add notes' })
    const forced = await captureDraft({ cwd: root, goal: 'add notes', force: true })

    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain('Pass --force to overwrite')
    expect(forced.code).toBe(0)
    expect(readFileSync(path, 'utf8')).toContain('# Plan: Add Notes')
  })

  it('requires markdown output paths', async () => {
    const root = tempRoot()

    const { code, stderr } = await captureDraft({
      cwd: root,
      goal: 'add notes',
      outputFile: '.choirmaster/plans/add-notes.txt',
    })

    expect(code).toBe(64)
    expect(stderr).toContain('draft output must be a markdown (.md) file')
    expect(existsSync(join(root, '.choirmaster/plans/add-notes.txt'))).toBe(false)
  })

  it('does not print an @ shortcut for output outside the project', async () => {
    const root = tempRoot()
    const outside = join(tempRoot(), 'outside.md')

    const { code, stdout } = await captureDraft({
      cwd: root,
      goal: 'outside plan',
      outputFile: outside,
    })

    expect(code).toBe(0)
    expect(stdout).toContain(`Edit it, then run: choirmaster run ${outside}`)
    expect(stdout).not.toContain('Shortcut after shell completions')
  })
})

async function captureDraft(
  args: Parameters<typeof draftCommand>[0],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString()
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString()
    return true
  }) as typeof process.stderr.write
  try {
    return { code: await draftCommand(args), stdout, stderr }
  }
  finally {
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
  }
}

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-draft-'))
  roots.push(root)
  return root
}
