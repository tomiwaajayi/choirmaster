/**
 * In-CLI markdown picker for environments where shell completion is not
 * installed. This keeps fuzzy matching as a user-confirmed interaction,
 * never an execution-time guess.
 */

import { stdin as defaultInput, stdout as defaultOutput } from 'node:process'
import { clearScreenDown, cursorTo, emitKeypressEvents } from 'node:readline'
import type { ReadStream, WriteStream } from 'node:tty'

import { listMarkdownFiles, searchMarkdownFiles } from './markdown-ref.js'

export type MarkdownPickerResult =
  | { ok: true; path: string }
  | { ok: false; code: number; message: string }

export interface MarkdownPickerOptions {
  cwd: string
  initialQuery?: string
  title?: string
  input?: ReadStream
  output?: WriteStream
}

export async function pickMarkdownFile(options: MarkdownPickerOptions): Promise<MarkdownPickerResult> {
  const input = options.input ?? defaultInput
  const output = options.output ?? defaultOutput
  const files = listMarkdownFiles(options.cwd)

  if (files.length === 0) {
    return {
      ok: false,
      code: 1,
      message: 'No markdown files found in this repo. Create one with `cm draft "your goal"` or pass an explicit plan path.',
    }
  }

  if (!input.isTTY || !output.isTTY) {
    return {
      ok: false,
      code: 64,
      message: 'No markdown file was selected. Pass <plan.md>, pass an exact @reference, or run this command in an interactive terminal.',
    }
  }

  return new Promise<MarkdownPickerResult>((resolve) => {
    let query = (options.initialQuery ?? '').replace(/^@/, '')
    let selected = 0
    let renderedLines = 0
    const title = options.title ?? 'Select a markdown file'

    emitKeypressEvents(input)
    const hadRawMode = input.isRaw
    input.setRawMode(true)
    input.resume()
    output.write('\x1b[?25l')

    const cleanup = (): void => {
      input.off('keypress', onKeypress)
      input.setRawMode(hadRawMode)
      output.write('\x1b[?25h')
    }

    const matches = (): string[] => {
      const found = searchMarkdownFiles(query, options.cwd, 10)
      if (selected >= found.length) selected = Math.max(0, found.length - 1)
      return found
    }

    const rerender = (): void => {
      if (renderedLines > 0) {
        output.write(`\x1b[${renderedLines}A`)
      }
      cursorTo(output, 0)
      clearScreenDown(output)

      const found = matches()
      const lines = [
        title,
        '',
        `Search: @${query}`,
        '',
      ]

      if (found.length === 0) {
        lines.push('  No markdown files match. Keep typing, Backspace to edit, Esc to cancel.')
      }
      else {
        lines.push('Use Up/Down to choose, Enter to select, Esc to cancel.')
        lines.push('')
        for (let i = 0; i < found.length; i += 1) {
          lines.push(`${i === selected ? '>' : ' '} ${found[i]}`)
        }
      }

      output.write(`${lines.join('\n')}\n`)
      renderedLines = lines.length
    }

    const finish = (result: MarkdownPickerResult): void => {
      cleanup()
      if (renderedLines > 0) {
        output.write(`\x1b[${renderedLines}A`)
        cursorTo(output, 0)
        clearScreenDown(output)
      }
      if (result.ok) {
        output.write(`Selected: ${result.path}\n`)
      }
      resolve(result)
    }

    const onKeypress = (str: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
      if (key.ctrl && key.name === 'c') {
        finish({ ok: false, code: 130, message: 'Selection cancelled.' })
        return
      }
      if (key.name === 'escape') {
        finish({ ok: false, code: 130, message: 'Selection cancelled.' })
        return
      }
      if (key.name === 'return') {
        const found = matches()
        const path = found[selected]
        if (path) finish({ ok: true, path })
        return
      }
      if (key.name === 'up') {
        selected = Math.max(0, selected - 1)
        rerender()
        return
      }
      if (key.name === 'down') {
        selected = Math.min(matches().length - 1, selected + 1)
        rerender()
        return
      }
      if (key.name === 'backspace') {
        query = query.slice(0, -1)
        selected = 0
        rerender()
        return
      }
      if (str && !key.ctrl && str >= ' ') {
        query += str === '@' && query.length === 0 ? '' : str
        selected = 0
        rerender()
      }
    }

    input.on('keypress', onKeypress)
    rerender()
  })
}
