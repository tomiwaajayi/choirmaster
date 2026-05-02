import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadManifest } from './manifest.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('loadManifest', () => {
  it('unwraps nested default exports from tsx-loaded manifests', async () => {
    const root = setupRepo()
    writeManifest(root, `export default {
  __esModule: true,
  default: ${projectConfig()},
}
`)

    const config = await loadManifest(root)

    expect(config.base).toBe('main')
    expect(config.prompts.reviewer).toBe('.choirmaster/prompts/reviewer.md')
  })
})

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-manifest-'))
  roots.push(root)
  mkdirSync(join(root, '.choirmaster'), { recursive: true })
  return root
}

function writeManifest(root: string, content: string): void {
  writeFileSync(join(root, '.choirmaster/manifest.mjs'), content)
}

function projectConfig(): string {
  return `{
    base: 'main',
    agents: {},
    gates: [],
    branchPolicy: { name: 'test-policy', async onTaskCompleted() { return { kind: 'failed', reason: 'not used' } } },
    sandbox: { name: 'test-sandbox', async setup() { throw new Error('not used') } },
    prompts: {
      planner: '.choirmaster/prompts/planner.md',
      planReviewer: '.choirmaster/prompts/plan-reviewer.md',
      implementer: '.choirmaster/prompts/implementer.md',
      reviewer: '.choirmaster/prompts/reviewer.md',
    },
  }`
}
