/**
 * Raw-mode input loop with live suggestions.
 *
 * Reads keys directly from stdin and maintains the current line, cursor,
 * and active suggestion list as a small state machine. Re-renders the
 * prompt + suggestion stack via `makeFrame`.
 *
 * Resolves with the typed line on Enter, or with the line that includes
 * the accepted suggestion. Resolves with a special "interrupt" outcome
 * for Ctrl-C while idle so the entry point can exit cleanly.
 *
 * Multi-line paste is preserved: when the decoder fires several keypress
 * events synchronously (one per character) and one of them is a newline,
 * we resolve the current line and queue the remainder for subsequent
 * reads. Without that, pasted content past the first newline would be
 * silently lost between the time we detach the listener and the rest of
 * the synchronous events fire.
 */

import { stdin as defaultInput, stdout as defaultOutput } from 'node:process'
import type { ReadStream, WriteStream } from 'node:tty'

import { ensureKeypressEvents } from './keypress.js'
import { buildSuggestionLines, makeFrame } from './render.js'
import { computeSuggestions } from './suggestions.js'
import type { Suggestion, SuggestionsResult } from './suggestions.js'
import type { Theme } from './theme.js'

export type ReadLineResult =
  | { kind: 'line'; line: string }
  | { kind: 'interrupt' }
  | { kind: 'eof' }

export interface ReadLineOptions {
  prompt: string
  cwd: string
  theme: Theme
  input?: ReadStream
  output?: WriteStream
}

interface KeyEvent {
  name?: string
  ctrl?: boolean
  meta?: boolean
  sequence?: string
}

// Module-level paste buffers. Populated by the drain listener installed
// when finish() runs; consumed at the top of the next readLineWithSuggestions
// call. Reset on shell exit (interactiveCommand) and on test teardown.
const pendingLines: string[] = []
let pendingPartial: string = ''

/**
 * Drop any buffered paste content. Production callers (the shell's
 * `finally` block on exit) use this so a re-entry into
 * `interactiveCommand` starts with no leftover input from a prior
 * session. Tests also call it for isolation between cases.
 */
export function resetPendingInputBuffer(): void {
  pendingLines.length = 0
  pendingPartial = ''
}

export async function readLineWithSuggestions(options: ReadLineOptions): Promise<ReadLineResult> {
  const input = options.input ?? defaultInput
  const output = options.output ?? defaultOutput
  const theme = options.theme

  if (!input.isTTY || !output.isTTY) {
    return { kind: 'eof' }
  }

  // If a previous paste buffered up extra content, dispatch the next
  // line synchronously without showing a prompt at all.
  if (pendingLines.length > 0) {
    const queued = pendingLines.shift()!
    output.write(`${theme.cyan(options.prompt)}${queued}\n`)
    return { kind: 'line', line: queued }
  }

  return new Promise<ReadLineResult>((resolve) => {
    let line = pendingPartial
    pendingPartial = ''
    let cursor = line.length
    let suggestions: SuggestionsResult | null = null
    let highlighted = 0
    let suppressed = false
    let resolved = false

    const frame = makeFrame(output)
    ensureKeypressEvents(input)
    const hadRawMode = input.isRaw
    input.setRawMode(true)
    input.resume()

    const rerender = (): void => {
      const promptLine = `${theme.cyan(options.prompt)}${line}`
      const lines: string[] = [promptLine]

      if (suggestions && suggestions.items.length > 0) {
        lines.push('')
        const built = buildSuggestionLines(suggestions.items, highlighted, undefined, theme)
        for (const l of built) lines.push(l)
      }

      const promptVisibleLength = options.prompt.length
      frame.draw(lines, 0, promptVisibleLength + cursor)
    }

    const recomputeSuggestions = (): void => {
      if (suppressed) {
        suggestions = null
        highlighted = 0
        return
      }
      const result = computeSuggestions(line, cursor, options.cwd)
      if (result && result.items.length > 0) {
        suggestions = result
        if (highlighted >= result.items.length) highlighted = 0
      }
      else {
        suggestions = null
        highlighted = 0
      }
    }

    /**
     * After we've decided to finish with the current line, swap to this
     * listener. It captures any same-tick keypresses produced by a
     * multi-line paste and stuffs them into the module-level queues.
     * Each Enter inside the drain pushes the buffered chars as a
     * separate `pendingLine`.
     */
    let drainBuffer = ''
    const drain = (str: string, key: KeyEvent): void => {
      if (key.ctrl && key.name === 'c') {
        // User wants out; drop everything pending.
        drainBuffer = ''
        pendingLines.length = 0
        return
      }
      if (key.name === 'return') {
        pendingLines.push(drainBuffer)
        drainBuffer = ''
        return
      }
      if (key.name === 'backspace') {
        drainBuffer = drainBuffer.slice(0, -1)
        return
      }
      if (str && !key.ctrl && !key.meta && str >= ' ') {
        drainBuffer += str
      }
    }

    const finish = (result: ReadLineResult): void => {
      if (resolved) return
      resolved = true

      // Stop responding to suggestion-aware keypresses; for the rest of
      // this synchronous tick, accumulate everything else into the
      // module-level queues. The actual raw-mode/listener teardown is
      // deferred to the next microtask so any pending sync events fire
      // through `drain` first.
      input.off('keypress', onKeypress)
      input.on('keypress', drain)
      queueMicrotask(() => {
        input.off('keypress', drain)
        if (drainBuffer) {
          // Trailing chars without a newline pre-fill the next prompt.
          pendingPartial = drainBuffer
          drainBuffer = ''
        }
        input.setRawMode(hadRawMode)
        input.pause()
      })

      // Drop the live suggestion frame, keep the typed line on screen so
      // the user sees what they ran, then advance to a fresh line.
      frame.clear()
      output.write(`${theme.cyan(options.prompt)}${line}\n`)
      resolve(result)
    }

    const acceptSuggestion = (): boolean => {
      if (!suggestions || suggestions.items.length === 0) return false
      const chosen = suggestions.items[highlighted]
      if (!chosen) return false
      const trailing = suggestions.kind === 'slash' ? ' ' : ''
      const result = applySuggestion(
        line,
        cursor,
        suggestions.tokenStart,
        chosen.value,
        trailing,
      )
      line = result.line
      cursor = result.cursor
      recomputeSuggestions()
      rerender()
      return true
    }

    const onKeypress = (str: string, key: KeyEvent): void => {
      if (resolved) return
      if (key.ctrl && key.name === 'c') {
        finish({ kind: 'interrupt' })
        return
      }
      if (key.ctrl && key.name === 'd' && line.length === 0) {
        finish({ kind: 'eof' })
        return
      }

      if (key.name === 'return') {
        // If the suggestion panel is open and the highlight differs from
        // what the user typed, accept the suggestion before executing.
        // This matches the convention every suggestion-driven shell uses
        // (VS Code, fzf, line editors): Enter both completes and runs.
        if (suggestions && suggestions.items.length > 0) {
          const chosen = suggestions.items[highlighted]
          if (chosen && chosen.value !== suggestions.token) {
            acceptSuggestion()
          }
        }
        finish({ kind: 'line', line })
        return
      }

      if (key.name === 'tab') {
        acceptSuggestion()
        return
      }

      if (key.name === 'escape') {
        if (suggestions) {
          suppressed = true
          suggestions = null
          rerender()
        }
        return
      }

      if (key.name === 'up') {
        if (suggestions && suggestions.items.length > 0) {
          highlighted = Math.max(0, highlighted - 1)
          rerender()
        }
        return
      }

      if (key.name === 'down') {
        if (suggestions && suggestions.items.length > 0) {
          highlighted = Math.min(suggestions.items.length - 1, highlighted + 1)
          rerender()
        }
        return
      }

      if (key.name === 'left' || key.name === 'right') {
        if (key.name === 'left') cursor = Math.max(0, cursor - 1)
        else cursor = Math.min(line.length, cursor + 1)
        recomputeSuggestions()
        rerender()
        return
      }

      if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
        cursor = 0
        recomputeSuggestions()
        rerender()
        return
      }
      if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
        cursor = line.length
        recomputeSuggestions()
        rerender()
        return
      }

      if (key.name === 'backspace') {
        if (cursor > 0) {
          line = line.slice(0, cursor - 1) + line.slice(cursor)
          cursor -= 1
        }
        if (line.length === 0) suppressed = false
        recomputeSuggestions()
        rerender()
        return
      }
      if (key.name === 'delete') {
        if (cursor < line.length) {
          line = line.slice(0, cursor) + line.slice(cursor + 1)
        }
        recomputeSuggestions()
        rerender()
        return
      }

      if (key.ctrl && key.name === 'u') {
        line = line.slice(cursor)
        cursor = 0
        suppressed = false
        recomputeSuggestions()
        rerender()
        return
      }

      if (key.ctrl && key.name === 'k') {
        line = line.slice(0, cursor)
        recomputeSuggestions()
        rerender()
        return
      }

      // Printable input. We accept any non-control string, including
      // multi-code-unit strings (UTF-16 surrogate pairs for emoji and
      // rare CJK). Cursor advances by the number of UTF-16 code units
      // since `line` is a JS string and indexing is by code unit.
      if (str && !key.ctrl && !key.meta && str >= ' ') {
        line = line.slice(0, cursor) + str + line.slice(cursor)
        cursor += str.length
        suppressed = false
        recomputeSuggestions()
        rerender()
      }
    }

    input.on('keypress', onKeypress)
    rerender()
  })
}

export type { Suggestion }

/**
 * Compute the new (line, cursor) after accepting a suggestion. Pure;
 * exported so tests can verify the mid-token clobber fix without
 * standing up a full input loop.
 *
 * The token under the cursor extends from `tokenStart` forward through
 * any non-whitespace characters at or past `cursor`. We replace that
 * full token with `value + trailing` and place the cursor right after
 * it. If we used `cursor` as the end-of-token (the original bug), a
 * mid-token accept would leave the tail of the original token wedged
 * onto the inserted suggestion: e.g. `/run @example` with cursor at
 * column 8 + accepting `@example.md` would yield `/run @example.mdample`.
 */
export interface ApplySuggestionResult {
  line: string
  cursor: number
}

export function applySuggestion(
  line: string,
  cursor: number,
  tokenStart: number,
  value: string,
  trailing: '' | ' ',
): ApplySuggestionResult {
  let tokenEnd = cursor
  while (tokenEnd < line.length && !/\s/.test(line.charAt(tokenEnd))) tokenEnd += 1
  const before = line.slice(0, tokenStart)
  const after = line.slice(tokenEnd)
  const newLine = `${before}${value}${trailing}${after}`
  return {
    line: newLine,
    cursor: before.length + value.length + trailing.length,
  }
}
