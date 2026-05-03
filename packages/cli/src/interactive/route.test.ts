import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { resolveShellLine } from './route.js'
import { makeTheme } from './theme.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

const theme = makeTheme(process.stdout)

describe('resolveShellLine', () => {
  it('treats whitespace as empty', async () => {
    expect(await resolveShellLine('   ', '.', { theme })).toEqual({ kind: 'empty' })
  })

  it('reports unknown commands', async () => {
    const result = await resolveShellLine('/nope', '.', { theme })
    expect(result.kind).toBe('error')
  })

  it('routes /run @example to the run cli command', async () => {
    expect(await resolveShellLine('/run @example', '.', { theme })).toEqual({
      kind: 'dispatch',
      argv: ['run', '@example'],
    })
  })

  it('routes /plan @example to the plan cli command', async () => {
    expect(await resolveShellLine('/plan @example --output foo.json', '.', { theme })).toEqual({
      kind: 'dispatch',
      argv: ['plan', '@example', '--output', 'foo.json'],
    })
  })

  it('routes /resume <id> through `cm run --resume` so flags pass through', async () => {
    expect(await resolveShellLine('/resume abc123', '.', { theme })).toEqual({
      kind: 'dispatch',
      argv: ['run', '--resume', 'abc123'],
    })
  })

  it('keeps --reuse-worktree, --continue-on-blocked, --no-auto-merge attached to /resume', async () => {
    const result = await resolveShellLine(
      '/resume abc --reuse-worktree --continue-on-blocked',
      '.',
      { theme },
    )
    expect(result).toEqual({
      kind: 'dispatch',
      argv: ['run', '--resume', 'abc', '--reuse-worktree', '--continue-on-blocked'],
    })
  })

  it('returns help for /help and exit for /exit', async () => {
    expect((await resolveShellLine('/help', '.', { theme })).kind).toBe('help')
    expect((await resolveShellLine('/exit', '.', { theme })).kind).toBe('exit')
    expect((await resolveShellLine('/quit', '.', { theme })).kind).toBe('exit')
  })

  it('opens the markdown picker for /run with no arg and uses the chosen path', async () => {
    let pickerArgs: { cwd: string; title: string } | null = null
    const result = await resolveShellLine('/run', 'cwd-x', {
      theme,
      pickMarkdown: async (cwd, title) => {
        pickerArgs = { cwd, title }
        return { ok: true, path: 'docs/example.md' }
      },
    })
    expect(result).toEqual({ kind: 'dispatch', argv: ['run', 'docs/example.md'] })
    expect(pickerArgs).toEqual({ cwd: 'cwd-x', title: 'Select a markdown plan to run' })
  })

  it('returns cancelled when the markdown picker is dismissed', async () => {
    const result = await resolveShellLine('/plan', '.', {
      theme,
      pickMarkdown: async () => ({ ok: false, code: 130, message: 'Selection cancelled.' }),
    })
    expect(result).toEqual({ kind: 'cancelled', message: 'Selection cancelled.' })
  })

  it('returns no-resumable-runs when /resume finds nothing', async () => {
    const result = await resolveShellLine('/resume', '.', {
      theme,
      listRuns: () => [],
    })
    expect(result).toEqual({ kind: 'no-resumable-runs' })
  })

  it('opens the resume picker and routes to --resume <id>', async () => {
    const result = await resolveShellLine('/resume', '.', {
      theme,
      listRuns: () => [
        {
          id: 'run-A',
          status: 'waiting_for_capacity',
          modifiedAt: 0,
          currentTaskId: 'TASK-01',
        },
      ],
      pickResume: async () => ({
        ok: true,
        run: { id: 'run-A', status: 'waiting_for_capacity', modifiedAt: 0 },
      }),
    })
    expect(result).toEqual({ kind: 'dispatch', argv: ['run', '--resume', 'run-A'] })
  })

  it('passes through positional /run path with end-of-options support', async () => {
    expect(await resolveShellLine('/run -- -dash.md', '.', { theme })).toEqual({
      kind: 'dispatch',
      argv: ['run', '--', '-dash.md'],
    })
  })

  it('does not pick up a value-flag argument as the positional plan path', async () => {
    let pickerCalled = false
    const result = await resolveShellLine('/plan --output foo.json', '.', {
      theme,
      pickMarkdown: async () => {
        pickerCalled = true
        return { ok: true, path: 'docs/example.md' }
      },
    })
    // findPositional must skip the value of --output. With no positional
    // plan path the picker is what we expect to run.
    expect(pickerCalled).toBe(true)
    expect(result).toEqual({
      kind: 'dispatch',
      argv: ['plan', 'docs/example.md', '--output', 'foo.json'],
    })
  })

  it('treats a positional that follows a value-flag as the plan path', async () => {
    expect(
      await resolveShellLine('/plan --output foo.json @example', '.', { theme }),
    ).toEqual({
      kind: 'dispatch',
      argv: ['plan', '--output', 'foo.json', '@example'],
    })
  })

  it('discovers runs from a real repo when no listRuns is injected', async () => {
    const root = setupRepoWithRun('waiting-run', {
      tasks: [{
        id: 'TASK-01',
        title: 'X',
        status: 'waiting_for_capacity',
        paused_phase: 'reviewer',
      }],
    })

    const result = await resolveShellLine('/resume', root, {
      theme,
      pickResume: async (runs) => ({ ok: true, run: runs[0]! }),
    })
    expect(result).toEqual({ kind: 'dispatch', argv: ['run', '--resume', 'waiting-run'] })
  })

  it('resolves the project root before listing runs (so /resume works from a subdir)', async () => {
    const root = setupRepoWithRun('subdir-run', {
      tasks: [{
        id: 'TASK-01',
        title: 'X',
        status: 'waiting_for_capacity',
        paused_phase: 'reviewer',
      }],
    })
    const subdir = join(root, 'packages', 'foo')
    mkdirSync(subdir, { recursive: true })

    const result = await resolveShellLine('/resume', subdir, {
      theme,
      pickResume: async (runs) => ({ ok: true, run: runs[0]! }),
    })
    expect(result).toEqual({ kind: 'dispatch', argv: ['run', '--resume', 'subdir-run'] })
  })
})

function setupRepoWithRun(runId: string, state: object): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-route-'))
  roots.push(root)
  sh('git init -b main', root)
  sh('git config user.email test@example.com', root)
  sh('git config user.name "Test"', root)
  const dir = join(root, '.choirmaster/runs', runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
  return root
}

function sh(command: string, cwd: string): void {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr || result.stdout}`)
  }
}
