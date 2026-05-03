import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { doctorCommand } from './doctor.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('doctorCommand', () => {
  it('passes a healthy repo with fake non-network agents', async () => {
    const root = setupRepo({ base: 'main' })
    const { code, output } = await captureDoctor(root)

    expect(code).toBe(0)
    expect(output).toContain('[ok] manifest:')
    expect(output).toContain('[ok] base branch: on main')
    expect(output).toContain('[ok] agent:implementer: fake:impl (fake:impl)')
    expect(output).toContain('0 failed')
  })

  it('checks claude CLI and Anthropic DNS when Claude is configured', async () => {
    const root = setupRepo({ base: 'main', engine: 'claude' })
    const commands: string[] = []
    const lookups: string[] = []

    const { code, output } = await captureDoctor(root, {
      commandRunner(command: string, args: string[]) {
        commands.push([command, ...args].join(' '))
        if (command === 'git') return { status: 0, stdout: 'git version test\n', stderr: '' }
        if (command === 'claude') return { status: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' }
        return { status: 1, stdout: '', stderr: 'unexpected command' }
      },
      async lookupHost(host: string) {
        lookups.push(host)
        return [{ address: '127.0.0.1', family: 4 }]
      },
    })

    expect(code).toBe(0)
    expect(commands).toContain('claude --version')
    expect(lookups).toEqual(['api.anthropic.com'])
    expect(output).toContain('[ok] claude CLI: 2.1.0 (Claude Code)')
    expect(output).toContain('[ok] network:Anthropic DNS: api.anthropic.com')
  })

  it('warns instead of failing when Anthropic DNS cannot resolve', async () => {
    const root = setupRepo({ base: 'main', engine: 'claude' })
    const { code, output } = await captureDoctor(root, {
      commandRunner: okCommandRunner,
      async lookupHost() {
        throw new Error('offline')
      },
    })

    expect(code).toBe(0)
    expect(output).toContain('[warn] network:Anthropic DNS: could not resolve api.anthropic.com: offline')
  })

  it('can skip network checks', async () => {
    const root = setupRepo({ base: 'main', engine: 'claude' })
    let lookups = 0
    const { code, output } = await captureDoctor(root, {
      commandRunner: okCommandRunner,
      skipNetwork: true,
      async lookupHost() {
        lookups += 1
        return []
      },
    })

    expect(code).toBe(0)
    expect(lookups).toBe(0)
    expect(output).toContain('[warn] network:Anthropic DNS: skipped (--skip-network)')
  })

  it('fails when the current branch does not match manifest.base', async () => {
    const root = setupRepo({ base: 'develop' })
    const { code, output } = await captureDoctor(root)

    expect(code).toBe(1)
    expect(output).toContain('[fail] base branch: on main; manifest.base is develop; run git checkout develop before choirmaster run')
  })

  it('does not require a planReviewer prompt when planReviewer is not configured', async () => {
    const root = setupRepo({ base: 'main', omitPlanReviewerPromptPath: true })
    const { code, output } = await captureDoctor(root)

    expect(code).toBe(0)
    expect(output).toContain('[ok] prompt:planReviewer: not configured; optional until plan-review iteration ships')
  })

  it('fails when a required prompt file is missing', async () => {
    const root = setupRepo({ base: 'main', omitPromptFile: 'implementer' })
    const { code, output } = await captureDoctor(root)

    expect(code).toBe(1)
    expect(output).toContain('[fail] prompt:implementer: missing .choirmaster/prompts/implementer.md')
  })

  it('fails before manifest checks when not inside a git repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-doctor-no-git-'))
    roots.push(root)

    const { code, output } = await captureDoctor(root)

    expect(code).toBe(1)
    expect(output).toContain('[fail] git repository: not inside a working git repository')
  })

  it('colors labels when stdout is a TTY and NO_COLOR is unset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-doctor-no-git-'))
    roots.push(root)

    const previousIsTTY = process.stdout.isTTY
    const previousNoColor = process.env.NO_COLOR
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
    delete process.env.NO_COLOR
    try {
      const { output } = await captureDoctor(root)
      // ANSI red for the [fail] label.
      expect(output).toContain('\x1b[31m[fail]\x1b[39m')
    }
    finally {
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: previousIsTTY })
      if (previousNoColor === undefined) delete process.env.NO_COLOR
      else process.env.NO_COLOR = previousNoColor
    }
  })
})

async function captureDoctor(
  cwd: string,
  options: Omit<Parameters<typeof doctorCommand>[0], 'cwd'> = {},
): Promise<{ code: number; output: string }> {
  let output = ''
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString()
    return true
  }) as typeof process.stdout.write
  try {
    return { code: await doctorCommand({ cwd, ...options }), output }
  }
  finally {
    process.stdout.write = originalWrite
  }
}

function setupRepo({
  base,
  engine = 'fake',
  omitPromptFile,
  omitPlanReviewerPromptPath = false,
  includePlanReviewerAgent = false,
}: {
  base: string
  engine?: string
  omitPromptFile?: string
  omitPlanReviewerPromptPath?: boolean
  includePlanReviewerAgent?: boolean
}): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-doctor-'))
  roots.push(root)
  sh('git init -b main', root)
  sh('git config user.email test@example.com', root)
  sh('git config user.name "Test"', root)

  mkdirSync(join(root, '.choirmaster/prompts'), { recursive: true })
  for (const prompt of ['planner', 'plan-reviewer', 'implementer', 'reviewer']) {
    if (prompt === omitPromptFile) continue
    writeFileSync(join(root, `.choirmaster/prompts/${prompt}.md`), `# ${prompt}\n`)
  }
  writeFileSync(join(root, '.gitignore'), '.choirmaster/runs/\n')
  writeFileSync(join(root, '.choirmaster/manifest.js'), manifest({
    base,
    engine,
    omitPlanReviewerPromptPath,
    includePlanReviewerAgent,
  }))
  sh('git add -A && git commit -m initial', root)
  return root
}

function manifest({
  base,
  engine,
  omitPlanReviewerPromptPath,
  includePlanReviewerAgent,
}: {
  base: string
  engine: string
  omitPlanReviewerPromptPath: boolean
  includePlanReviewerAgent: boolean
}): string {
  const planReviewerAgent = includePlanReviewerAgent ? "    planReviewer: fake('plan-reviewer'),\n" : ''
  const planReviewerPrompt = omitPlanReviewerPromptPath
    ? ''
    : "    planReviewer: '.choirmaster/prompts/plan-reviewer.md',\n"
  return `const fake = (model) => ({
  name: \`${engine}:\${model}\`,
  engine: ${JSON.stringify(engine)},
  model,
  async invoke() {
    throw new Error('not used by doctor')
  },
})

export default {
  base: ${JSON.stringify(base)},
  agents: {
    planner: fake('planner'),
    implementer: fake('impl'),
${planReviewerAgent}    reviewer: fake('reviewer'),
  },
  gates: [
    { name: 'test', command: 'npm test' },
  ],
  branchPolicy: { name: 'test-policy', async onTaskCompleted() { return { kind: 'failed', reason: 'not used' } } },
  sandbox: { name: 'test-sandbox', async setup() { throw new Error('not used') } },
  prompts: {
    planner: '.choirmaster/prompts/planner.md',
${planReviewerPrompt}    implementer: '.choirmaster/prompts/implementer.md',
    reviewer: '.choirmaster/prompts/reviewer.md',
  },
  forbiddenPaths: ['.env', '.env.*'],
  strictInstructions: [],
}
`
}

function okCommandRunner(command: string, args: string[]): { status: number; stdout: string; stderr: string } {
  if (command === 'git') return { status: 0, stdout: 'git version test\n', stderr: '' }
  if (command === 'claude') return { status: 0, stdout: '2.1.0 (Claude Code)\n', stderr: '' }
  return { status: 1, stdout: '', stderr: `unexpected command: ${[command, ...args].join(' ')}` }
}

function sh(command: string, cwd: string): void {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr || result.stdout}`)
  }
}
