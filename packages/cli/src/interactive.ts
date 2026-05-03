/**
 * Persistent ChoirMaster prompt.
 *
 * This is the CLI-owned input surface: slash commands belong to
 * ChoirMaster, and @ completion uses the same markdown matcher as the
 * command-line picker without relying on shell-specific completion.
 */

import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

import { completeMarkdownReferences } from './markdown-ref.js'

const SLASH_COMMANDS = [
  '/help',
  '/doctor',
  '/draft',
  '/plan',
  '/run',
  '/resume',
  '/exit',
  '/quit',
]

const INTERACTIVE_HELP = `ChoirMaster interactive commands:

  /draft [goal...]              Create a markdown plan
  /draft --interactive [goal]   Ask concise questions before writing a plan
  /plan [plan.md|@query]        Pick or decompose a markdown plan
  /run [plan.md|@query]         Pick or run a markdown plan
  /resume <run-id>              Resume a paused or interrupted run
  /doctor                       Check local setup
  /help                         Show this help
  /exit                         Leave ChoirMaster

Tips:
  Type /run with no path to open the markdown picker.
  Type @ inside /run or /plan and press Tab for ChoirMaster-owned suggestions.
`

export interface InteractiveCommandArgs {
  dispatch: (args: string[]) => Promise<number>
  cwd?: string
}

export async function interactiveCommand(args: InteractiveCommandArgs): Promise<number> {
  const cwd = args.cwd ?? process.cwd()
  stdout.write('ChoirMaster interactive\n')
  stdout.write('Type /help for commands. Type /exit to quit.\n\n')

  while (true) {
    const rl = createInterface({
      input: stdin,
      output: stdout,
      completer: (line: string) => completeInteractiveLine(line, cwd),
    })

    let line: string
    try {
      line = await rl.question('cm> ')
    }
    catch {
      rl.close()
      stdout.write('\n')
      return 130
    }
    rl.close()

    const parsed = parseInteractiveLine(line)
    if (parsed.kind === 'empty') continue
    if (parsed.kind === 'error') {
      stdout.write(`${parsed.message}\n`)
      continue
    }
    if (parsed.command === '/help') {
      stdout.write(`${INTERACTIVE_HELP}\n`)
      continue
    }
    if (parsed.command === '/exit' || parsed.command === '/quit') {
      return 0
    }

    const dispatchArgs = toCliArgs(parsed.command, parsed.args)
    if (!dispatchArgs) {
      stdout.write(`Unknown command: ${parsed.command}. Type /help.\n`)
      continue
    }
    await args.dispatch(dispatchArgs)
    stdout.write('\n')
  }
}

type ParsedInteractiveLine =
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

export function completeInteractiveLine(line: string, cwd: string): [string[], string] {
  const atMatch = line.match(/(^|\s)(@[^\s]*)$/)
  if (atMatch) {
    const word = atMatch[2] ?? '@'
    return [completeMarkdownReferences(word, cwd), word]
  }

  const slashMatch = line.match(/(^|\s)(\/[^\s]*)$/)
  if (slashMatch) {
    const word = slashMatch[2] ?? '/'
    return [SLASH_COMMANDS.filter((command) => command.startsWith(word)), word]
  }

  return [[], line]
}

function toCliArgs(command: string, args: string[]): string[] | null {
  switch (command) {
    case '/doctor':
      return ['doctor', ...args]
    case '/draft':
      return ['draft', ...args]
    case '/plan':
      return ['plan', ...args]
    case '/run':
      return ['run', ...args]
    case '/resume':
      return ['--resume', ...args]
    default:
      return null
  }
}

type SplitArgsResult =
  | { ok: true; args: string[] }
  | { ok: false; error: string }

function splitArgs(input: string): SplitArgsResult {
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
