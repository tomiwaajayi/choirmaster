/**
 * Loads the user's `.choirmaster/manifest.{ts,mjs,js}` and validates it
 * looks like a ProjectConfig. TypeScript manifests are loaded via tsx's
 * programmatic API; ESM JS manifests are imported directly.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ProjectConfig } from '@choirmaster/core'

const CANDIDATES = [
  '.choirmaster/manifest.ts',
  '.choirmaster/manifest.mjs',
  '.choirmaster/manifest.js',
]
const REQUIRED_KEYS = ['base', 'agents', 'gates', 'branchPolicy', 'sandbox', 'prompts'] as const

export async function loadManifest(projectRoot: string): Promise<ProjectConfig> {
  for (const rel of CANDIDATES) {
    const abs = join(projectRoot, rel)
    if (existsSync(abs)) {
      return loadManifestFile(abs)
    }
  }
  throw new Error(
    `No manifest found. Looked for ${CANDIDATES.map((c) => `"${c}"`).join(', ')} `
    + `in ${projectRoot}. Run \`choirmaster init\` to scaffold one.`,
  )
}

async function loadManifestFile(absolutePath: string): Promise<ProjectConfig> {
  let mod: unknown
  if (absolutePath.endsWith('.ts')) {
    const { tsImport } = await import('tsx/esm/api')
    mod = await tsImport(absolutePath, import.meta.url)
  }
  else {
    const url = pathToFileURL(absolutePath).href
    mod = await import(url)
  }
  return assertProjectConfig(mod, absolutePath)
}

function assertProjectConfig(mod: unknown, source: string): ProjectConfig {
  if (mod === null || typeof mod !== 'object') {
    throw new Error(`Manifest at ${source} did not export an object.`)
  }
  const candidate = unwrapManifestExport(mod)
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error(`Manifest at ${source} default export must be a ProjectConfig object.`)
  }
  const config = candidate as Partial<ProjectConfig>
  for (const key of REQUIRED_KEYS) {
    if (!(key in config)) {
      throw new Error(`Manifest at ${source} is missing required field: ${key}`)
    }
  }
  return config as ProjectConfig
}

function unwrapManifestExport(value: unknown): unknown {
  let candidate = value
  for (let depth = 0; depth < 5; depth += 1) {
    if (hasProjectConfigShape(candidate)) {
      return candidate
    }
    if (candidate === null || typeof candidate !== 'object' || !('default' in candidate)) {
      return candidate
    }
    const next = (candidate as { default?: unknown }).default
    if (next === undefined || next === candidate) {
      return candidate
    }
    candidate = next
  }
  return candidate
}

function hasProjectConfigShape(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && REQUIRED_KEYS.every((key) => key in value)
}
