import { describe, expect, it } from 'vitest'

import {
  buildSuggestionLines,
  makeFrame,
  renderBanner,
  renderContextLine,
  renderHelp,
  renderResumableList,
} from './render.js'
import { makeTheme } from './theme.js'

// All tests use a non-color theme so assertions stay readable.
const fakeStdout = { isTTY: false } as unknown as NodeJS.WriteStream
const theme = makeTheme(fakeStdout)

describe('renderContextLine', () => {
  it('shows repo name plus optional branch / base / dirty / resumable', () => {
    const line = renderContextLine(
      { repoName: 'app', branch: 'main', base: 'main', dirty: false, resumableCount: 0 },
      theme,
    )
    expect(line).toContain('repo: app')
    expect(line).toContain('branch: main')
    expect(line).toContain('base: main')
    expect(line).not.toContain('dirty')
    expect(line).not.toContain('resumable')
  })

  it('flags dirty trees and pluralizes resumable count correctly', () => {
    const oneRun = renderContextLine(
      { repoName: 'r', dirty: true, resumableCount: 1 },
      theme,
    )
    expect(oneRun).toContain('dirty')
    expect(oneRun).toContain('1 resumable run')
    expect(oneRun).not.toContain('runs')

    const twoRuns = renderContextLine(
      { repoName: 'r', dirty: false, resumableCount: 2 },
      theme,
    )
    expect(twoRuns).toContain('2 resumable runs')
  })
})

describe('renderBanner', () => {
  it('always opens with ChoirMaster, the context line, and a usage hint', () => {
    const banner = renderBanner(
      { repoName: 'app', branch: 'main', base: 'main', dirty: false, resumableCount: 0 },
      theme,
    )
    expect(banner).toMatch(/^ChoirMaster\n/)
    expect(banner).toContain('repo: app')
    expect(banner).toContain('Type / for commands')
  })
})

describe('renderHelp', () => {
  it('lists every shell command and includes example invocations', () => {
    const help = renderHelp(theme)
    for (const cmd of ['/draft', '/plan', '/run', '/resume', '/doctor', '/help', '/exit']) {
      expect(help).toContain(cmd)
    }
    expect(help).toContain('Examples')
    expect(help).toContain('/run @example')
    expect(help).toContain('cm --resume')
  })
})

describe('renderResumableList', () => {
  it('shows the empty-state hint when no runs exist', () => {
    const out = renderResumableList([], theme)
    expect(out).toContain('No resumable runs.')
    expect(out).toContain('/run')
  })

  it('summarizes runs with id, status tag, task, and reason', () => {
    const out = renderResumableList(
      [
        {
          id: 'run-A',
          status: 'waiting_for_capacity',
          modifiedAt: 0,
          currentTaskId: 'TASK-01',
          currentTaskTitle: 'Implement X',
          reason: 'capacity hit during reviewer',
        },
      ],
      theme,
    )
    expect(out).toContain('run-A')
    expect(out).toContain('waiting')
    expect(out).toContain('TASK-01')
    expect(out).toContain('Implement X')
    expect(out).toContain('capacity hit during reviewer')
  })
})

describe('buildSuggestionLines', () => {
  it('renders each suggestion with marker, value, and hint', () => {
    const lines = buildSuggestionLines(
      [{ value: '/run', hint: 'Run a markdown plan' }],
      0,
      undefined,
      theme,
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('/run')
    expect(lines[0]).toContain('Run a markdown plan')
  })

  it('caps at 8 visible items and shows an overflow line', () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ value: `/x${i}` }))
    const lines = buildSuggestionLines(items, 0, undefined, theme)
    expect(lines).toHaveLength(9)
    expect(lines[8]).toContain('+4 more')
  })

  it('returns an empty array for no suggestions', () => {
    expect(buildSuggestionLines(undefined, 0, undefined, theme)).toEqual([])
    expect(buildSuggestionLines([], 0, undefined, theme)).toEqual([])
  })
})

describe('makeFrame', () => {
  it('rejects out-of-range cursor rows', () => {
    const writes: string[] = []
    const fakeOut = {
      write: (chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
        return true
      },
    } as unknown as NodeJS.WriteStream
    const frame = makeFrame(fakeOut)
    expect(() => frame.draw(['only line'], 5, 0)).toThrow(/cursorRow 5/)
    expect(() => frame.draw(['only line'], -1, 0)).toThrow(/cursorRow -1/)
    expect(() => frame.draw(['only line'], 0, -2)).toThrow(/cursorCol -2/)
  })

  it('treats an empty lines array as a clear', () => {
    const writes: string[] = []
    const fakeOut = {
      write: (chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
        return true
      },
    } as unknown as NodeJS.WriteStream
    const frame = makeFrame(fakeOut)
    frame.draw([], 0, 0)
    // Empty draw emits a column-reset (\x1b[1G; terminals are 1-indexed)
    // and a clear-below (\x1b[0J), but never throws or writes content.
    const out = writes.join('')
    expect(out).toContain('\x1b[1G')
    expect(out).toContain('\x1b[0J')
  })

  it('rewinds physical rows (not logical) when content wraps the terminal', () => {
    const writes: string[] = []
    const fakeOut = {
      columns: 10,
      write: (chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
        return true
      },
    } as unknown as NodeJS.WriteStream
    const frame = makeFrame(fakeOut)
    // 25 visible chars in a 10-col terminal: 3 physical rows. Anchor
    // the cursor at the END of the line (col 25) so it lives on the
    // third physical row (row 2).
    const longLine = 'x'.repeat(25)
    frame.draw([longLine], 0, 25)
    writes.length = 0
    // Second draw rewinds two rows to reach the frame top, then clears
    // and writes. With the old (logical-only) math, no rewind would
    // happen and the wrapped tail would persist visually.
    frame.draw(['short'], 0, 0)
    const out = writes.join('')
    // ESC[2A means "cursor up 2".
    expect(out).toContain('\x1b[2A')
  })

  it('forces \\r\\n after a last line that ends exactly at the column boundary', () => {
    // Reviewer-flagged P2: cursorCol === cols leaves the terminal in
    // pending-wrap state on delayed-wrap terminals (xterm/iTerm/kitty).
    // Without an explicit CR-LF, cursorTo(0) lands at col 0 of the same
    // row instead of col 0 of the next row, visibly clobbering the
    // line we just wrote. The frame now emits `\r\n` for boundary-
    // ending last lines so positioning is deterministic.
    const writes: string[] = []
    const fakeOut = {
      columns: 10,
      write: (chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
        return true
      },
    } as unknown as NodeJS.WriteStream
    const frame = makeFrame(fakeOut)
    // Exactly cols characters with cursor at the line's end.
    frame.draw(['x'.repeat(10)], 0, 10)
    const out = writes.join('')
    expect(out).toContain('\r\n')
    // Cursor should land at col 0 of the row after the content.
    expect(out).toMatch(/\x1b\[1G\s*$/)
  })

  it('handles cursorCol === 2 * cols (line that wraps two physical rows exactly)', () => {
    const writes: string[] = []
    const fakeOut = {
      columns: 10,
      write: (chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
        return true
      },
    } as unknown as NodeJS.WriteStream
    const frame = makeFrame(fakeOut)
    frame.draw(['x'.repeat(20)], 0, 20)
    const out = writes.join('')
    // Must force a CR-LF so the cursor anchors at col 0 of the row
    // below the two content rows (delayed-wrap would otherwise leave
    // it pending at col 9 of row 1).
    expect(out).toContain('\r\n')
  })

  it('boundary frame rewinds the right number of rows on the next draw', () => {
    const writes: string[] = []
    const fakeOut = {
      columns: 10,
      write: (chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
        return true
      },
    } as unknown as NodeJS.WriteStream
    const frame = makeFrame(fakeOut)
    // First draw: 10-char line with cursor at boundary. Frame uses
    // physRows = 1 (content) + 1 (forced \r\n) = 2; cursor lands at row 1.
    frame.draw(['x'.repeat(10)], 0, 10)
    writes.length = 0
    // Second draw: rewind 1 row to reach the frame's top row.
    frame.draw(['short'], 0, 0)
    const out = writes.join('')
    expect(out).toContain('\x1b[1A')
  })

  it('positions the cursor on the wrapped row when cursorCol exceeds terminal width', () => {
    const writes: string[] = []
    const fakeOut = {
      columns: 10,
      write: (chunk: string | Uint8Array) => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
        return true
      },
    } as unknown as NodeJS.WriteStream
    const frame = makeFrame(fakeOut)
    // Logical row 0 with cursorCol=15: col % 10 = 5, row offset = 1.
    // After writing 25 chars (3 phys rows), the cursor sits on row 2;
    // we need to move up 1 row to land on row 1, col 5.
    frame.draw(['x'.repeat(25)], 0, 15)
    const out = writes.join('')
    expect(out).toContain('\x1b[1A')
    // Final cursor positioning lands at col 5 (1-indexed: \x1b[6G).
    expect(out).toContain('\x1b[6G')
  })
})
