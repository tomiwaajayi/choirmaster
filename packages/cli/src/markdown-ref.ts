import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'

import { findGitRoot } from './project-root.js'

export type MarkdownReferenceResult =
  | { ok: true; path: string; matched: boolean }
  | { ok: false; message: string; suggestions: string[]; suggestionsLabel?: string }

export function completeMarkdownReferences(input: string, cwd: string): string[] {
  if (!input.startsWith('@')) return []

  const query = input.slice(1).trim().toLowerCase()
  const matches = searchMarkdownFiles(query, cwd, 50)
  return matches.slice(0, 50).map((path) => `@${path.replace(/[\n\r]/g, '')}`)
}

export function searchMarkdownFiles(queryInput: string, cwd: string, limit = 50): string[] {
  const query = queryInput.replace(/^@/, '').trim().toLowerCase()
  const files = listMarkdownFiles(cwd)
  const matches = query ? findMarkdownMatches(files, query) : files
  return matches.slice(0, limit)
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

  const files = listMarkdownFiles(cwd)
  const exactMatches = findExactMarkdownMatches(files, query)
  if (exactMatches.length === 1) {
    return { ok: true, path: exactMatches[0]!, matched: true }
  }
  if (exactMatches.length > 1) {
    return {
      ok: false,
      message: `Multiple markdown files exactly match @${rawQuery}. Choose one with shell completion, or pass the explicit markdown path.`,
      suggestions: exactMatches.slice(0, 20),
    }
  }

  const suggestions = findMarkdownMatches(files, query).slice(0, 20)
  if (suggestions.length === 0) {
    return {
      ok: false,
      message: `No markdown files match @${rawQuery}.`,
      suggestions: [],
    }
  }

  return {
    ok: false,
    message: `@${rawQuery} is not an exact markdown reference. Use shell completion to choose a file, or pass the explicit markdown path.`,
    suggestions,
  }
}

export function formatMarkdownReferenceError(result: Extract<MarkdownReferenceResult, { ok: false }>): string {
  const lines = [result.message]
  if (result.suggestions.length > 0) {
    lines.push('')
    lines.push(result.suggestionsLabel ?? 'Matches:')
    for (const suggestion of result.suggestions) {
      lines.push(`  ${suggestion.replace(/[\n\r]/g, '')}`)
    }
  }
  return `${lines.join('\n')}\n`
}

export function listMarkdownFiles(cwd: string): string[] {
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
    .filter((path) => !path.startsWith('.choirmaster/prompts/'))
    .sort((a, b) => a.localeCompare(b))
}

function findMarkdownMatches(files: string[], query: string): string[] {
  return files
    .map((path) => ({ path, score: scoreMatch(path, query) }))
    .filter((match) => match.score !== null)
    .sort((a, b) => a.score! - b.score! || a.path.localeCompare(b.path))
    .map((match) => match.path)
}

function findExactMarkdownMatches(files: string[], query: string): string[] {
  return files.filter((path) => isExactMarkdownMatch(path, query))
}

function isExactMarkdownMatch(path: string, query: string): boolean {
  const lowerPath = path.toLowerCase()
  const lowerBase = basename(lowerPath)
  const baseWithoutExt = lowerBase.endsWith('.md') ? lowerBase.slice(0, -3) : lowerBase
  const pathWithoutExt = lowerPath.endsWith('.md') ? lowerPath.slice(0, -3) : lowerPath
  return lowerPath === query
    || pathWithoutExt === query
    || lowerBase === query
    || baseWithoutExt === query
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
