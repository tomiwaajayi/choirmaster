import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { initCommand } from './init.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('initCommand', () => {
  it('gitignores generated runtime artifacts in new projects', async () => {
    const root = tempRoot()

    const code = await initCommand({ cwd: root })

    expect(code).toBe(0)
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.choirmaster/runs/')
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.choirmaster/tasks/')
    expect(existsSync(join(root, '.choirmaster/plans/example.md'))).toBe(true)
    expect(existsSync(join(root, '.choirmaster/tasks'))).toBe(true)
    expect(existsSync(join(root, '.choirmaster/plans/example.tasks.json'))).toBe(false)
  })

  it('initializes manifest.base from the current git branch', async () => {
    const root = tempRoot()
    sh('git init -b toms-playground', root)

    const code = await initCommand({ cwd: root })
    const manifest = readFileSync(join(root, '.choirmaster/manifest.ts'), 'utf8')

    expect(code).toBe(0)
    expect(manifest).toContain('base: "toms-playground"')
  })

  it('preserves slashes in branch names', async () => {
    const root = tempRoot()
    sh('git init -b feature/foo', root)

    const code = await initCommand({ cwd: root })
    const manifest = readFileSync(join(root, '.choirmaster/manifest.ts'), 'utf8')

    expect(code).toBe(0)
    expect(manifest).toContain('base: "feature/foo"')
  })

  it('safely escapes branch names with embedded quotes', async () => {
    const root = tempRoot()
    sh('git init -q', root)
    sh('git symbolic-ref HEAD refs/heads/\'tom"s-branch\'', root)

    const code = await initCommand({ cwd: root })
    const manifest = readFileSync(join(root, '.choirmaster/manifest.ts'), 'utf8')

    expect(code).toBe(0)
    expect(manifest).toContain('base: "tom\\"s-branch"')
  })

  it('falls back to main on detached HEAD', async () => {
    const root = tempRoot()
    sh('git init -b main', root)
    sh('git config user.email test@example.com', root)
    sh('git config user.name Test', root)
    sh('git commit --allow-empty -m initial', root)
    sh('git checkout --detach HEAD', root)

    const code = await initCommand({ cwd: root })
    const manifest = readFileSync(join(root, '.choirmaster/manifest.ts'), 'utf8')

    expect(code).toBe(0)
    expect(manifest).toContain('base: "main"')
  })

  it('falls back to main outside a git repository', async () => {
    const root = tempRoot()

    const code = await initCommand({ cwd: root })
    const manifest = readFileSync(join(root, '.choirmaster/manifest.ts'), 'utf8')

    expect(code).toBe(0)
    expect(manifest).toContain('base: "main"')
  })

  it('adds missing ChoirMaster ignore rules without duplicating existing ones', async () => {
    const root = tempRoot()
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.choirmaster/runs/\n')

    const code = await initCommand({ cwd: root })
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')

    expect(code).toBe(0)
    expect(count(gitignore, '.choirmaster/runs/')).toBe(1)
    expect(count(gitignore, '.choirmaster/tasks/')).toBe(1)
  })

  it('does not add a second ChoirMaster header when upgrading an old gitignore block', async () => {
    const root = tempRoot()
    writeFileSync(
      join(root, '.gitignore'),
      '# ChoirMaster per-run state and logs (do not commit)\n.choirmaster/runs/\n',
    )

    const code = await initCommand({ cwd: root })
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')

    expect(code).toBe(0)
    expect(count(gitignore, '# ChoirMaster')).toBe(1)
    expect(gitignore).toContain('.choirmaster/tasks/')
  })

  it('does not add a redundant tasks entry when the tasks directory is already ignored', async () => {
    const root = tempRoot()
    writeFileSync(join(root, '.gitignore'), '.choirmaster/runs/\n.choirmaster/tasks/\n')

    const code = await initCommand({ cwd: root })
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')

    expect(code).toBe(0)
    expect(count(gitignore, '.choirmaster/tasks/')).toBe(1)
  })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-init-'))
  roots.push(root)
  return root
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1
}

function sh(command: string, cwd: string): void {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr || result.stdout}`)
  }
}
