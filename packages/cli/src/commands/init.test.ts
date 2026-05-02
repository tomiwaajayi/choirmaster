import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('.choirmaster/plans/*.tasks.json')
  })

  it('adds missing ChoirMaster ignore rules without duplicating existing ones', async () => {
    const root = tempRoot()
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.choirmaster/runs/\n')

    const code = await initCommand({ cwd: root })
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8')

    expect(code).toBe(0)
    expect(count(gitignore, '.choirmaster/runs/')).toBe(1)
    expect(count(gitignore, '.choirmaster/plans/*.tasks.json')).toBe(1)
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
