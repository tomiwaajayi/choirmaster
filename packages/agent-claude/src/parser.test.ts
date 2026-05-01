import { describe, expect, it } from 'vitest'

import { parseStreamLine, prettyEvent } from './parser.js'

describe('parseStreamLine', () => {
  it('returns no events for blank or invalid lines', () => {
    expect(parseStreamLine('')).toEqual([])
    expect(parseStreamLine('   ')).toEqual([])
    expect(parseStreamLine('not json at all')).toEqual([])
  })

  it('extracts text and tool_use from an assistant event', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'tool_use', name: 'Edit', input: { file_path: 'a/b.ts' } },
        ],
      },
    })
    expect(parseStreamLine(line)).toEqual([
      { kind: 'text', text: 'Hello' },
      { kind: 'tool_use', name: 'Edit', input: { file_path: 'a/b.ts' } },
    ])
  })

  it('extracts thinking blocks distinctly from text', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'reasoning here' },
        ],
      },
    })
    expect(parseStreamLine(line)).toEqual([{ kind: 'thinking', text: 'reasoning here' }])
  })

  it('flags tool_result errors, drops successes', () => {
    const errorLine = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', is_error: true, content: 'permission denied' },
        ],
      },
    })
    expect(parseStreamLine(errorLine)).toEqual([
      { kind: 'tool_result', ok: false, snippet: 'permission denied' },
    ])

    const okLine = JSON.stringify({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', is_error: false, content: 'ok' },
        ],
      },
    })
    expect(parseStreamLine(okLine)).toEqual([
      { kind: 'tool_result', ok: true, snippet: 'ok' },
    ])
  })

  it('flags result events that carry an error', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, error: 'usage limit hit' })
    expect(parseStreamLine(line)).toEqual([{ kind: 'error', message: 'usage limit hit' }])
  })

  it('ignores result events that succeeded', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success' })
    expect(parseStreamLine(line)).toEqual([])
  })

  it('extracts content from tool_result blocks shaped as arrays', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            is_error: true,
            content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
          },
        ],
      },
    })
    const events = parseStreamLine(line)
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('tool_result')
    if (events[0]?.kind === 'tool_result') {
      expect(events[0].ok).toBe(false)
      expect(events[0].snippet).toContain('first')
      expect(events[0].snippet).toContain('second')
    }
  })
})

describe('prettyEvent', () => {
  it('formats Edit tool_use with the file path', () => {
    expect(prettyEvent({ kind: 'tool_use', name: 'Edit', input: { file_path: 'a/b.ts' } }))
      .toBe('  → Edit a/b.ts')
  })

  it('truncates long Bash commands', () => {
    const long = 'x'.repeat(200)
    const out = prettyEvent({ kind: 'tool_use', name: 'Bash', input: { command: long } })
    expect(out?.length).toBeLessThan(120)
    expect(out?.startsWith('  → Bash:')).toBe(true)
  })

  it('drops successful tool_results from the visible stream', () => {
    expect(prettyEvent({ kind: 'tool_result', ok: true })).toBeNull()
  })

  it('shows tool_result errors with snippet', () => {
    expect(prettyEvent({ kind: 'tool_result', ok: false, snippet: 'oops' }))
      .toBe('  ✗ oops')
  })

  it('drops thinking blocks from the visible stream', () => {
    expect(prettyEvent({ kind: 'thinking', text: 'hidden reasoning' })).toBeNull()
  })

  it('surfaces error events with prefix', () => {
    expect(prettyEvent({ kind: 'error', message: 'boom' })).toBe('[error] boom')
  })
})
