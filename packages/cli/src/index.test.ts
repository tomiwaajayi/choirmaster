import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { main } from './index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('CLI completion dispatch', () => {
  it('prints markdown reference candidates for shell adapters', async () => {
    const root = setupRepo({
      '.choirmaster/plans/example.md': '# Example\n',
      'docs/roadmap.md': '# Roadmap\n',
    })

    const { code, stdout } = await captureMain(root, ['node', 'cm', '__complete', 'markdown', '@ex'])

    expect(code).toBe(0)
    expect(stdout).toBe('@.choirmaster/plans/example.md\n')
  })

  it('prints markdown reference candidates from repo subdirectories', async () => {
    const root = setupRepo({
      '.choirmaster/plans/example.md': '# Example\n',
      'packages/cli/README.md': '# CLI\n',
    })

    const { code, stdout } = await captureMain(
      join(root, 'packages/cli'),
      ['node', 'cm', '__complete', 'markdown', '@example'],
    )

    expect(code).toBe(0)
    expect(stdout).toBe('@.choirmaster/plans/example.md\n')
  })

  it('prints completion scripts from the public command', async () => {
    const root = setupRepo()

    const { code, stdout } = await captureMain(root, ['node', 'cm', 'completions', 'bash'])

    expect(code).toBe(0)
    expect(stdout).toContain('complete -F _choirmaster_completion cm')
  })

  it('dispatches draft goals to the draft command', async () => {
    const root = setupRepo()

    const { code, stdout } = await captureMain(root, ['node', 'cm', 'draft', 'add', 'rate', 'limits'])

    expect(code).toBe(0)
    expect(stdout).toContain('Draft plan created: .choirmaster/plans/add-rate-limits.md')
    expect(readFileSync(join(root, '.choirmaster/plans/add-rate-limits.md'), 'utf8'))
      .toContain('# Plan: Add Rate Limits')
  })

  it('reports missing flag values before consuming the next flag token', async () => {
    const root = setupRepo()

    const draft = await captureMain(root, ['node', 'cm', 'draft', '--from', '--output', 'foo.md'])
    const plan = await captureMain(root, ['node', 'cm', 'plan', '--output', '--force', 'plan.md'])
    const doctor = await captureMain(root, ['node', 'cm', 'doctor', '--cwd', '--skip-network'])
    const run = await captureMain(root, ['node', 'cm', 'run', '--resume', '--no-auto-merge'])

    expect(draft).toMatchObject({ code: 64, stderr: '--from requires a value.\n' })
    expect(plan).toMatchObject({ code: 64, stderr: '--output requires a value.\n' })
    expect(doctor).toMatchObject({ code: 64, stderr: '--cwd requires a value.\n' })
    expect(run).toMatchObject({ code: 64, stderr: '--resume requires a value.\n' })
  })

  it('supports -- as end-of-options for draft goals and positional inputs', async () => {
    const root = setupRepo({
      '-dash-plan.md': '# Dash plan\n',
    })

    const draft = await captureMain(root, ['node', 'cm', 'draft', '--', '--leading-dash', 'goal'])
    const plan = await captureMain(root, ['node', 'cm', 'plan', '--', '-dash-plan.md'])

    expect(draft.code).toBe(0)
    expect(readFileSync(join(root, '.choirmaster/plans/leading-dash-goal.md'), 'utf8'))
      .toContain('## Goal\n\n--leading-dash goal')
    expect(plan.code).toBe(1)
    expect(plan.stderr).toContain('No manifest found')
  })
})

async function captureMain(
  cwd: string,
  argv: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const originalCwd = process.cwd()
  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  process.chdir(cwd)
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString()
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString()
    return true
  }) as typeof process.stderr.write
  try {
    return { code: await main(argv), stdout, stderr }
  }
  finally {
    process.chdir(originalCwd)
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
  }
}

function setupRepo(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-cli-'))
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
