/**
 * Drive readLineWithSuggestions with a fake TTY pair.
 *
 * The test fakes both stdin and stdout so the input loop's state
 * machine can be exercised without the real terminal. We mark the fake
 * input as having keypress events already installed (via the public
 * symbol marker) so `ensureKeypressEvents` short-circuits and we can
 * fire 'keypress' events synchronously.
 */

import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it } from 'vitest'

import { applySuggestion, resetPendingInputBuffer, readLineWithSuggestions } from './input.js'
import { makeTheme } from './theme.js'

afterEach(() => {
  resetPendingInputBuffer()
})

const KEYPRESS_INSTALLED = Symbol.for('choirmaster.keypressInstalled')

interface KeyEvent {
  name?: string
  ctrl?: boolean
  meta?: boolean
  sequence?: string
}

class FakeInput extends EventEmitter {
  isTTY: boolean = true
  isRaw: boolean = false
  rawCalls: boolean[] = [];
  pauseCalls: number = 0
  resumeCalls: number = 0;
  // Pretend the keypress decoder is already installed so the input
  // loop's `ensureKeypressEvents` is a no-op. The semicolons above
  // disambiguate the symbol-indexed field from accidental ASI.
  [KEYPRESS_INSTALLED]: boolean = true

  setRawMode(value: boolean): this {
    this.isRaw = value
    this.rawCalls.push(value)
    return this
  }

  resume(): this {
    this.resumeCalls += 1
    return this
  }

  pause(): this {
    this.pauseCalls += 1
    return this
  }

  press(sequence: string, key: KeyEvent = {}): void {
    this.emit('keypress', sequence, { ...key, sequence: key.sequence ?? sequence })
  }

  type(text: string): void {
    for (const ch of text) this.press(ch)
  }
}

class FakeOutput extends EventEmitter {
  isTTY: boolean = true
  columns: number = 120
  chunks: string[] = []

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }

  text(): string {
    return this.chunks.join('')
  }
}

/**
 * Stream shaped like a TTY ReadStream that lets us push raw bytes
 * through Node's real emitKeypressEvents decoder. We don't pre-mark
 * the keypress-installed symbol so `ensureKeypressEvents` actually
 * runs and wires up Node's data-to-keypress decoder.
 */
class RealDecoderInput extends EventEmitter {
  isTTY: boolean = true
  isRaw: boolean = false

  setRawMode(value: boolean): this {
    this.isRaw = value
    return this
  }

  resume(): this {
    return this
  }

  pause(): this {
    return this
  }

  /** Synchronously emit a 'data' event so the keypress decoder runs. */
  pushBytes(text: string): void {
    this.emit('data', Buffer.from(text, 'utf8'))
  }
}

function makePair(): { input: FakeInput; output: FakeOutput } {
  return {
    input: new FakeInput(),
    output: new FakeOutput(),
  }
}

const theme = makeTheme({ isTTY: false } as unknown as NodeJS.WriteStream)

describe('readLineWithSuggestions', () => {
  it('returns kind:eof when stdin is not a TTY', async () => {
    const { input, output } = makePair()
    input.isTTY = false
    const result = await readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    expect(result).toEqual({ kind: 'eof' })
  })

  it('resolves with the typed line on Enter', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.type('hello')
    input.press('', { name: 'return' })
    const result = await promise
    expect(result).toEqual({ kind: 'line', line: 'hello' })
  })

  it('Ctrl-C returns interrupt', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.press('', { name: 'c', ctrl: true })
    expect(await promise).toEqual({ kind: 'interrupt' })
  })

  it('Ctrl-D on empty line returns eof; on a non-empty line is a no-op', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.press('a')
    // Ctrl-D with content should NOT close the loop.
    input.press('', { name: 'd', ctrl: true })
    // Backspace away the content, then Ctrl-D closes.
    input.press('', { name: 'backspace' })
    input.press('', { name: 'd', ctrl: true })
    expect(await promise).toEqual({ kind: 'eof' })
  })

  it('Enter on /r with the panel open accepts /run before executing', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.type('/r')
    input.press('', { name: 'return' })
    expect(await promise).toEqual({ kind: 'line', line: '/run ' })
  })

  it('Enter without an open panel returns the literal line', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.type('/r')
    input.press('', { name: 'escape' })
    input.press('', { name: 'return' })
    expect(await promise).toEqual({ kind: 'line', line: '/r' })
  })

  it('Tab accepts the highlighted slash suggestion', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.type('/r')
    // First match is /run (declared before /resume in commands.ts).
    input.press('', { name: 'tab' })
    input.press('', { name: 'return' })
    expect(await promise).toEqual({ kind: 'line', line: '/run ' })
  })

  it('Down then Tab accepts the second slash suggestion', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.type('/r')
    input.press('', { name: 'down' })
    input.press('', { name: 'tab' })
    input.press('', { name: 'return' })
    expect(await promise).toEqual({ kind: 'line', line: '/resume ' })
  })

  it('Esc dismisses the suggestion list and stays dismissed until the line clears', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.type('/r')
    input.press('', { name: 'escape' })
    // Tab now does nothing because suggestions are suppressed.
    input.press('', { name: 'tab' })
    input.press('', { name: 'return' })
    expect(await promise).toEqual({ kind: 'line', line: '/r' })
  })

  it('backspace edits the line and reactivates suggestions on next keystroke', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.type('/runx')
    input.press('', { name: 'backspace' })
    input.press('', { name: 'return' })
    expect(await promise).toEqual({ kind: 'line', line: '/run' })
  })

  it('Ctrl-U deletes from cursor to start of line', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.type('/exit')
    input.press('', { name: 'u', ctrl: true })
    input.type('/help')
    input.press('', { name: 'return' })
    expect(await promise).toEqual({ kind: 'line', line: '/help' })
  })

  it('home moves cursor to column 0 and end moves to line end', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.type('bcd')
    input.press('', { name: 'home' })
    input.press('a')
    input.press('', { name: 'end' })
    input.press('e')
    input.press('', { name: 'return' })
    expect(await promise).toEqual({ kind: 'line', line: 'abcde' })
  })

  it('cleans up: pause and setRawMode(false) called once on exit', async () => {
    const { input, output } = makePair()
    input.isRaw = false
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.press('', { name: 'return' })
    await promise
    // We set raw on entry, restored to false on exit.
    expect(input.rawCalls).toEqual([true, false])
    expect(input.pauseCalls).toBe(1)
    // No keypress listeners should remain.
    expect(input.listenerCount('keypress')).toBe(0)
  })

  it('is idempotent against duplicate Enter events in the same tick', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.press('', { name: 'return' })
    // Fire a second event after finish() has run. The resolved guard
    // should swallow it without throwing.
    input.press('', { name: 'return' })
    await promise
    // Cleanup is microtask-deferred so a same-tick double-Enter should
    // still only pause once.
    await Promise.resolve()
    expect(input.pauseCalls).toBe(1)
  })

  it('multi-line paste: first line resolves, remainder shows up on the next read', async () => {
    const { input, output } = makePair()
    const first = await runOne(input, output, () => {
      input.type('hello')
      input.press('', { name: 'return' })
      // These events fire in the same tick AFTER finish swaps to drain.
      input.type('world')
      input.press('', { name: 'return' })
      input.type('three')
      input.press('', { name: 'return' })
    })
    expect(first).toEqual({ kind: 'line', line: 'hello' })

    const second = await runOne(input, output)
    expect(second).toEqual({ kind: 'line', line: 'world' })

    const third = await runOne(input, output)
    expect(third).toEqual({ kind: 'line', line: 'three' })
  })

  it('multi-line paste with a trailing partial line pre-fills the next prompt', async () => {
    const { input, output } = makePair()
    const first = await runOne(input, output, () => {
      input.type('hello')
      input.press('', { name: 'return' })
      input.type('partial')
    })
    expect(first).toEqual({ kind: 'line', line: 'hello' })

    // Next read starts with 'partial' as the existing line, then user
    // hits Enter to commit it.
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.press('', { name: 'return' })
    expect(await promise).toEqual({ kind: 'line', line: 'partial' })
  })

  it('accepts non-BMP printable characters (emoji) as a single insertion', async () => {
    const { input, output } = makePair()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    // emitKeypressEvents typically delivers a non-BMP code point as one
    // 2-code-unit string. The old `str.length === 1` guard rejected it.
    input.press('🎉')
    input.press('', { name: 'return' })
    expect(await promise).toEqual({ kind: 'line', line: '🎉' })
  })

})

describe('readLineWithSuggestions (real Node decoder)', () => {
  // The FakeInput suite above emits keypress events directly, which is
  // fast and ergonomic but bypasses Node's actual emitKeypressEvents
  // decoder. The bugs that motivated this suite (multi-line paste lost
  // events between listener detach and same-tick decoder output, and
  // non-BMP characters arriving as a single multi-code-unit string)
  // ONLY show up when bytes go through the real decoder. Keep at
  // least one smoke that exercises that path so a regression there
  // can't slip past the fast tests.
  function makeRealStream(): RealDecoderInput {
    return new RealDecoderInput()
  }

  it('decodes raw bytes into a line on a single Enter', async () => {
    const input = makeRealStream()
    const output = new FakeOutput()
    const promise = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    input.pushBytes('hi\r')
    expect(await promise).toEqual({ kind: 'line', line: 'hi' })
  })

  it('preserves a multi-line paste through the real decoder', async () => {
    const input = makeRealStream()
    const output = new FakeOutput()
    const first = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    // One single byte buffer with two newlines: the canonical paste shape.
    input.pushBytes('hello\rworld\r')
    expect(await first).toEqual({ kind: 'line', line: 'hello' })

    const second = readLineWithSuggestions({
      prompt: 'cm> ',
      cwd: '.',
      theme,
      input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
      output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
    })
    expect(await second).toEqual({ kind: 'line', line: 'world' })
  })
})

describe('applySuggestion', () => {
  it('replaces the entire token, including the tail past the cursor (mid-token clobber fix)', () => {
    // Reproduce the bug from review pass three:
    //   line = '/run @example', cursor=8 (between 'x' and 'a' of @example),
    //   tokenStart=5, accept '@example.md'.
    // Old code used `line.slice(cursor)` for `after`, producing
    // '/run @example.mdample'. The fix walks tokenEnd forward to the
    // next whitespace.
    const result = applySuggestion('/run @example', 8, 5, '@example.md', '')
    expect(result.line).toBe('/run @example.md')
    expect(result.cursor).toBe('/run @example.md'.length)
  })

  it('respects trailing space for slash suggestions', () => {
    const result = applySuggestion('/r', 2, 0, '/run', ' ')
    expect(result.line).toBe('/run ')
    expect(result.cursor).toBe(5)
  })

  it('preserves whitespace and tokens after the accepted token', () => {
    const result = applySuggestion('/run @ex --flag', 8, 5, '@example.md', '')
    expect(result.line).toBe('/run @example.md --flag')
  })

  it('handles end-of-line cursor positions', () => {
    const result = applySuggestion('/run @ex', 8, 5, '@example.md', '')
    expect(result.line).toBe('/run @example.md')
  })
})

async function runOne(
  input: FakeInput,
  output: FakeOutput,
  drive?: () => void,
): Promise<unknown> {
  const promise = readLineWithSuggestions({
    prompt: 'cm> ',
    cwd: '.',
    theme,
    input: input as unknown as NodeJS.ReadStream & { isTTY?: boolean },
    output: output as unknown as NodeJS.WriteStream & { isTTY?: boolean },
  })
  drive?.()
  return promise
}
