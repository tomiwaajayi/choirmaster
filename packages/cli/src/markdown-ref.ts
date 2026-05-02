import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

import { findGitRoot } from './project-root.js'

export type MarkdownReferenceResult =
  | { ok: true; path: string; matched: boolean }
  | { ok: false; message: string; suggestions: string[]; suggestionsLabel?: string }

export function completeMarkdownReferences(input: string, cwd: string): string[] {
  if (!input.startsWith('@')) return []

  const query = input.slice(1).trim().toLowerCase()
  const files = listMarkdownFiles(cwd)
  const matches = query ? findMarkdownMatches(files, query) : files
  return matches.slice(0, 50).map((path) => `@${path.replace(/[\n\r]/g, '')}`)
}

export function resolveMarkdownReference(input: string, cwd: string): MarkdownReferenceResult {
  if (!input.startsWith('@')) return { ok: true, path: input, matched: false }

  const rawQuery = input.slice(1).trim()
  const query = rawQuery.toLowerCase()
  if (!query) {
    return {
      ok: false,
      message: 'Type some text after @ to match a markdown file.',
      suggestions: listMarkdownFiles(cwd).slice(0, 20),
      suggestionsLabel: 'Markdown files in this repo:',
    }
  }

  const matches = findMarkdownMatches(listMarkdownFiles(cwd), query)
  if (matches.length === 0) {
    return {
      ok: false,
      message: `No markdown files match @${rawQuery}.`,
      suggestions: [],
    }
  }
  if (matches.length === 1) {
    return { ok: true, path: matches[0]!, matched: true }
  }

  return {
    ok: false,
    message: `Multiple markdown files match @${rawQuery}. Keep typing more of the path.`,
    suggestions: matches.slice(0, 20),
  }
}

export function formatMarkdownReferenceError(result: Extract<MarkdownReferenceResult, { ok: false }>): string {
  const lines = [result.message]
  if (result.suggestions.length > 0) {
    lines.push('')
    lines.push(result.suggestionsLabel ?? 'Matches:')
    for (const suggestion of result.suggestions) {
      lines.push(`  ${suggestion}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function listMarkdownFiles(cwd: string): string[] {
  const repoRoot = findGitRoot(cwd)
  if (!repoRoot) return []

  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'buffer',
  })
  if (result.status !== 0) return []

  return result.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter((path) => path.toLowerCase().endsWith('.md'))
    .filter((path) => !path.startsWith('.choirmaster/runs/'))
    .sort((a, b) => a.localeCompare(b))
}

function findMarkdownMatches(files: string[], query: string): string[] {
  return files
    .map((path) => ({ path, score: scoreMatch(path, query) }))
    .filter((match) => match.score !== null)
    .sort((a, b) => a.score! - b.score! || a.path.localeCompare(b.path))
    .map((match) => match.path)
}

function scoreMatch(path: string, query: string): number | null {
  const lowerPath = path.toLowerCase()
  const lowerBase = basename(lowerPath)
  const baseWithoutExt = lowerBase.endsWith('.md') ? lowerBase.slice(0, -3) : lowerBase

  // Lower score wins. Tiers: exact, base prefix, basename prefix,
  // path prefix, base substring, path substring. Within a tier,
  // shorter paths sort first via the length component.
  if (lowerPath === query || lowerBase === query || baseWithoutExt === query) return 0
  if (baseWithoutExt.startsWith(query)) return 10 + baseWithoutExt.length
  if (lowerBase.startsWith(query)) return 20 + lowerBase.length
  if (lowerPath.startsWith(query)) return 30 + lowerPath.length
  if (baseWithoutExt.includes(query)) return 40 + baseWithoutExt.indexOf(query) + baseWithoutExt.length
  if (lowerPath.includes(query)) return 50 + lowerPath.indexOf(query) + lowerPath.length
  return null
}
