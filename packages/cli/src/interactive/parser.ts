/**
 * Parses a single line of interactive input into a slash command + args.
 *
 * Pure: no IO. The shell calls this on Enter; tests call it directly.
 */

export type ParsedInteractiveLine =
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'command'; command: string; args: string[] }

export function parseInteractiveLine(line: string): ParsedInteractiveLine {
  const trimmed = line.trim()
  if (!trimmed) return { kind: 'empty' }
  const tokens = splitArgs(trimmed)
  if (!tokens.ok) return { kind: 'error', message: tokens.error }
  const [command, ...args] = tokens.args
  if (!command?.startsWith('/')) {
    return { kind: 'error', message: 'Start interactive commands with /. Type /help.' }
  }
  return { kind: 'command', command, args }
}

type SplitArgsResult =
  | { ok: true; args: string[] }
  | { ok: false; error: string }

export function splitArgs(input: string): SplitArgsResult {
  const args: string[] = []
  let current = ''
  let quote: '"' | '\'' | null = null
  let escaped = false

  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (escaped) current += '\\'
  if (quote) return { ok: false, error: `Unclosed ${quote} quote.` }
  if (current) args.push(current)
  return { ok: true, args }
}
