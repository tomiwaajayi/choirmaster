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
    const topLevelResume = await captureMain(root, ['node', 'cm', '--resume'])

    expect(draft).toMatchObject({ code: 64, stderr: '--from requires a value.\n' })
    expect(plan).toMatchObject({ code: 64, stderr: '--output requires a value.\n' })
    expect(doctor).toMatchObject({ code: 64, stderr: '--cwd requires a value.\n' })
    expect(run).toMatchObject({ code: 64, stderr: '--resume requires a value.\n' })
    expect(topLevelResume).toMatchObject({ code: 64, stderr: '--resume requires a value.\n' })
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

  it('run @query executes the task contract generated under .choirmaster/tasks', async () => {
    const root = setupPlanThenRunRepo()

    const { code, stdout } = await captureMain(root, ['node', 'cm', 'run', '@example'])

    expect(code).toBe(2)
    expect(stdout).toContain('Plan generated: 1 task(s) -> .choirmaster/tasks/example.tasks.json')
    expect(stdout).toContain('Task contract written for inspection. Run with: choirmaster run @example')
    expect(stdout).toContain('1 task(s) loaded from .choirmaster/tasks/example.tasks.json')
    expect(stdout).toContain('sandbox.setup failed: planned-contract-loaded')
    expect(stdout).toContain('To continue this run:\n  cm --resume ')
  })

  it('does not guess a fuzzy @ reference in non-interactive execution', async () => {
    const root = setupPlanThenRunRepo()

    const { code, stderr } = await captureMain(root, ['node', 'cm', 'run', '@exam'])

    expect(code).toBe(64)
    expect(stderr).toContain('@exam is not an exact markdown reference')
    expect(stderr).toContain('.choirmaster/plans/example.md')
  })

  it('offers the built-in picker when no plan input is passed in non-interactive execution', async () => {
    const root = setupPlanThenRunRepo()

    const { code, stderr } = await captureMain(root, ['node', 'cm', 'plan'])

    expect(code).toBe(64)
    expect(stderr).toContain('Pass <plan.md>, pass an exact @reference, or run this command in an interactive terminal')
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

function setupPlanThenRunRepo(): string {
  const root = setupRepo({
    '.choirmaster/plans/example.md': '# Example\n',
    '.choirmaster/prompts/planner.md': '# Planner\n',
    '.choirmaster/prompts/implementer.md': '# Implementer\n',
    '.choirmaster/prompts/reviewer.md': '# Reviewer\n',
    '.choirmaster/manifest.js': fakeManifest(),
  })
  return root
}

function fakeManifest(): string {
  return `const task = {
  id: 'TASK-01',
  title: 'Example',
  branch: 'choirmaster/task-01',
  worktree: '.choirmaster/runs/active/worktrees/task-01',
  allowed_paths: ['NOTES.md'],
  forbidden_paths: [],
  gates: [],
  definition_of_done: ['NOTES.md exists'],
}

const planner = {
  name: 'fake:planner',
  engine: 'fake',
  model: 'planner',
  async invoke(opts) {
    const outputRel = opts.userPrompt.match(/\\.choirmaster\\/tasks\\/\\.tmp\\/plan-output-[^\\s]+\\.json/)?.[0]
    if (!outputRel) throw new Error('missing planner output path')
    await import('node:fs').then(({ mkdirSync, writeFileSync }) => {
      const outputPath = opts.cwd + '/' + outputRel
      mkdirSync(outputPath.replace(/\\/[^/]+$/, ''), { recursive: true })
      writeFileSync(outputPath, JSON.stringify([task]))
    })
    return { status: 0, stdout: '', stderr: '', durationMs: 1, capacityHit: false }
  },
}

export default {
  base: 'main',
  agents: {
    planner,
    implementer: planner,
    reviewer: planner,
  },
  gates: [],
  branchPolicy: { name: 'test-policy', async onTaskCompleted() { return { kind: 'ok' } } },
  sandbox: { name: 'test-sandbox', async setup() { throw new Error('planned-contract-loaded') } },
  prompts: {
    planner: '.choirmaster/prompts/planner.md',
    implementer: '.choirmaster/prompts/implementer.md',
    reviewer: '.choirmaster/prompts/reviewer.md',
  },
  forbiddenPaths: ['.env', '.env.*'],
  strictInstructions: [],
}
`
}

function sh(command: string, cwd: string): void {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr || result.stdout}`)
  }
}
