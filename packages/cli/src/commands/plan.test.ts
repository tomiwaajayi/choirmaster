import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { defaultTasksOutputPath, planCommand } from './plan.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('defaultTasksOutputPath', () => {
  it('writes scaffolded plan contracts into .choirmaster/tasks', () => {
    const root = '/repo'

    expect(defaultTasksOutputPath(join(root, '.choirmaster/plans/example.md'), root))
      .toBe(join(root, '.choirmaster/tasks/example.tasks.json'))
  })

  it('preserves non-scaffolded plan folders under .choirmaster/tasks', () => {
    const root = '/repo'

    expect(defaultTasksOutputPath(join(root, 'docs/migrations/scss-to-tailwind.md'), root))
      .toBe(join(root, '.choirmaster/tasks/docs/migrations/scss-to-tailwind.tasks.json'))
  })
})

describe('planCommand', () => {
  it('writes generated task contracts into .choirmaster/tasks by default', async () => {
    const root = setupRepo()
    const { code, stdout } = await capturePlan(root, {
      planFile: '.choirmaster/plans/example.md',
      force: true,
    })

    expect(code).toBe(0)
    expect(stdout).toContain('Plan generated: 1 task(s) -> .choirmaster/tasks/example.tasks.json')
    expect(stdout).toContain('Run with: choirmaster run .choirmaster/tasks/example.tasks.json')
    expect(existsSync(join(root, '.choirmaster/tasks/example.tasks.json'))).toBe(true)
    expect(existsSync(join(root, '.choirmaster/plans/example.tasks.json'))).toBe(false)
    expect(JSON.parse(readFileSync(join(root, '.choirmaster/tasks/example.tasks.json'), 'utf8')))
      .toHaveLength(1)
  })
})

async function capturePlan(
  cwd: string,
  args: Parameters<typeof planCommand>[0],
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
    return { code: await planCommand({ cwd, ...args }), stdout, stderr }
  }
  finally {
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
  }
}

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-plan-command-'))
  roots.push(root)
  sh('git init -b main', root)
  sh('git config user.email test@example.com', root)
  sh('git config user.name "Test"', root)

  mkdirSync(join(root, '.choirmaster/prompts'), { recursive: true })
  mkdirSync(join(root, '.choirmaster/plans'), { recursive: true })
  writeFileSync(join(root, '.choirmaster/prompts/planner.md'), '# planner\n')
  writeFileSync(join(root, '.choirmaster/prompts/implementer.md'), '# implementer\n')
  writeFileSync(join(root, '.choirmaster/prompts/reviewer.md'), '# reviewer\n')
  writeFileSync(join(root, '.choirmaster/plans/example.md'), '# Example\n')
  writeFileSync(join(root, '.choirmaster/manifest.js'), manifest())

  sh('git add -A && git commit -m initial', root)
  return root
}

function manifest(): string {
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
    await import('node:fs').then(({ mkdirSync, writeFileSync }) => {
      mkdirSync(opts.cwd + '/.choirmaster', { recursive: true })
      writeFileSync(opts.cwd + '/.choirmaster/plan-output.json', JSON.stringify([task]))
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
  sandbox: { name: 'test-sandbox', async setup() { throw new Error('not used') } },
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
