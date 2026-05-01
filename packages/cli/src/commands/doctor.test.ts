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

  it('fails when the current branch does not match manifest.base', async () => {
    const root = setupRepo({ base: 'develop' })
    const { code, output } = await captureDoctor(root)

    expect(code).toBe(1)
    expect(output).toContain('[fail] base branch: on main; manifest.base is develop')
  })

  it('fails before manifest checks when not inside a git repo', async () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-doctor-no-git-'))
    roots.push(root)

    const { code, output } = await captureDoctor(root)

    expect(code).toBe(1)
    expect(output).toContain('[fail] git repository: not inside a working git repository')
  })
})

async function captureDoctor(cwd: string): Promise<{ code: number; output: string }> {
  let output = ''
  const originalWrite = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString()
    return true
  }) as typeof process.stdout.write
  try {
    return { code: await doctorCommand({ cwd }), output }
  }
  finally {
    process.stdout.write = originalWrite
  }
}

function setupRepo({ base }: { base: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-doctor-'))
  roots.push(root)
  sh('git init -b main', root)
  sh('git config user.email test@example.com', root)
  sh('git config user.name "Test"', root)

  mkdirSync(join(root, '.choirmaster/prompts'), { recursive: true })
  for (const prompt of ['planner', 'plan-reviewer', 'implementer', 'reviewer']) {
    writeFileSync(join(root, `.choirmaster/prompts/${prompt}.md`), `# ${prompt}\n`)
  }
  writeFileSync(join(root, '.gitignore'), '.choirmaster/runs/\n')
  writeFileSync(join(root, '.choirmaster/manifest.js'), manifest(base))
  sh('git add -A && git commit -m initial', root)
  return root
}

function manifest(base: string): string {
  return `const fake = (name) => ({
  name: \`fake:\${name}\`,
  engine: 'fake',
  model: name,
  async invoke() {
    throw new Error('not used by doctor')
  },
})

export default {
  base: ${JSON.stringify(base)},
  agents: {
    planner: fake('planner'),
    implementer: fake('impl'),
    reviewer: fake('reviewer'),
  },
  gates: [
    { name: 'test', command: 'npm test' },
  ],
  branchPolicy: { name: 'test-policy', async onTaskCompleted() { return { kind: 'failed', reason: 'not used' } } },
  sandbox: { name: 'test-sandbox', async setup() { throw new Error('not used') } },
  prompts: {
    planner: '.choirmaster/prompts/planner.md',
    planReviewer: '.choirmaster/prompts/plan-reviewer.md',
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
