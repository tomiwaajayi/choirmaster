import { describe, expect, it } from 'vitest'

import { parseInteractiveLine, splitArgs } from './parser.js'

describe('parseInteractiveLine', () => {
  it('parses a slash command with no args', () => {
    expect(parseInteractiveLine('/help')).toEqual({
      kind: 'command',
      command: '/help',
      args: [],
    })
  })

  it('parses quoted args', () => {
    expect(parseInteractiveLine('/draft "add email sharing" --interactive')).toEqual({
      kind: 'command',
      command: '/draft',
      args: ['add email sharing', '--interactive'],
    })
  })

  it('rejects bare words without a leading slash', () => {
    expect(parseInteractiveLine('run @example')).toEqual({
      kind: 'error',
      message: 'Start interactive commands with /. Type /help.',
    })
  })

  it('treats whitespace-only input as empty', () => {
    expect(parseInteractiveLine('   ')).toEqual({ kind: 'empty' })
  })

  it('reports an unclosed quote', () => {
    expect(parseInteractiveLine('/draft "not closed')).toEqual({
      kind: 'error',
      message: 'Unclosed " quote.',
    })
  })
})

describe('splitArgs', () => {
  it('splits double-quoted strings', () => {
    expect(splitArgs('a "b c" d')).toEqual({ ok: true, args: ['a', 'b c', 'd'] })
  })

  it('honors backslash escapes', () => {
    expect(splitArgs('a\\ b c')).toEqual({ ok: true, args: ['a b', 'c'] })
  })
})
