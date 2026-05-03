/**
 * Live-suggestion logic for the interactive shell. Pure functions.
 *
 * The shell's input loop calls `computeSuggestions(line, cursor, cwd)`
 * on every keystroke and renders whatever the result describes. Keeping
 * this stateless makes it easy to test and easy to reason about
 * (no surprise IO triggered by typing).
 */

import { completeMarkdownReferences } from '../markdown-ref.js'

import { SHELL_COMMANDS } from './commands.js'

export type SuggestionKind = 'slash' | 'markdown'

export interface Suggestion {
  /** What gets inserted into the line when the user accepts. */
  value: string
  /** Optional short label shown next to the value (e.g. command summary). */
  hint?: string
}

export interface SuggestionsResult {
  kind: SuggestionKind
  /** Token under the cursor that triggered the suggestion. */
  token: string
  /** Index in `line` where `token` starts (used to splice on accept). */
  tokenStart: number
  items: Suggestion[]
}

/**
 * Returns the slash- or markdown-token under the cursor (or null).
 * The token starts at either the beginning of the line or after
 * whitespace, and ends at the cursor.
 */
export function tokenUnderCursor(
  line: string,
  cursor: number,
): { kind: '/' | '@'; token: string; start: number } | null {
  const upToCursor = line.slice(0, cursor)
  // Walk back from the cursor to the last whitespace.
  let start = cursor
  while (start > 0 && !/\s/.test(line.charAt(start - 1))) start -= 1
  const token = upToCursor.slice(start)
  if (token.startsWith('/')) return { kind: '/', token, start }
  if (token.startsWith('@')) return { kind: '@', token, start }
  return null
}

export function computeSuggestions(
  line: string,
  cursor: number,
  cwd: string,
): SuggestionsResult | null {
  const here = tokenUnderCursor(line, cursor)
  if (!here) return null

  // Skip leading whitespace when computing "first token" so that
  // accidental leading spaces don't disable suggestions.
  const trimmedLine = line.replace(/^\s+/, '')
  const offset = line.length - trimmedLine.length

  if (here.kind === '/') {
    // Slash suggestions are anchored to the first non-whitespace token
    // on the line. /run @ex should not re-open the slash list.
    const firstToken = trimmedLine.split(/\s+/)[0] ?? ''
    if (here.start !== offset || here.token !== firstToken) return null
    return {
      kind: 'slash',
      token: here.token,
      tokenStart: here.start,
      items: filterSlashCommands(here.token),
    }
  }

  // Markdown suggestions: only valid arg of /run and /plan. /draft
  // takes a free-form goal string and a `--from <path>` flag that
  // doesn't resolve @-references; suggesting markdown there would
  // insert tokens the draft command can't consume.
  const firstToken = (trimmedLine.split(/\s+/)[0] ?? '').toLowerCase()
  const allowsMarkdown = firstToken === '/run' || firstToken === '/plan'
  if (!allowsMarkdown) return null

  return {
    kind: 'markdown',
    token: here.token,
    tokenStart: here.start,
    items: completeMarkdownReferences(here.token, cwd).map((value) => ({ value })),
  }
}

export function filterSlashCommands(prefix: string): Suggestion[] {
  // Match case-insensitively so /R surfaces /run and /resume; the
  // dispatcher is also case-insensitive (see findShellCommand).
  const lower = prefix.toLowerCase()
  return SHELL_COMMANDS
    .filter((cmd) => cmd.name.startsWith(lower))
    .map((cmd) => ({ value: cmd.name, hint: cmd.summary }))
}
