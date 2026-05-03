import { describe, expect, it } from 'vitest'

import { stripAnsi } from './strip-ansi.js'

describe('stripAnsi', () => {
  it('removes CSI sequences (color, cursor moves, screen clears)', () => {
    expect(stripAnsi('\x1b[31mred\x1b[39m')).toBe('red')
    expect(stripAnsi('hello\x1b[2Jworld')).toBe('helloworld')
    expect(stripAnsi('\x1b[1;2H')).toBe('')
  })

  it('removes OSC sequences ending in BEL or ESC-backslash', () => {
    expect(stripAnsi('\x1b]0;title\x07rest')).toBe('rest')
    expect(stripAnsi('\x1b]0;title\x1b\\rest')).toBe('rest')
  })

  it('removes other control characters that affect the terminal', () => {
    expect(stripAnsi('a\x00b')).toBe('ab')
    expect(stripAnsi('a\x07b')).toBe('ab')
    expect(stripAnsi('a\x7fb')).toBe('ab')
  })

  it('preserves ordinary newlines and tabs', () => {
    expect(stripAnsi('line1\nline2\tcol')).toBe('line1\nline2\tcol')
  })

  it('passes plain text through unchanged', () => {
    expect(stripAnsi('plain old text')).toBe('plain old text')
    expect(stripAnsi('')).toBe('')
  })
})
