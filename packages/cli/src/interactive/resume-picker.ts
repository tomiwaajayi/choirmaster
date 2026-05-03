/**
 * Interactive picker for resumable runs. Mirrors `pickMarkdownFile`'s
 * raw-mode loop so users get the same Up/Down/Enter/Esc behavior.
 */

import { stdin as defaultInput, stdout as defaultOutput } from 'node:process'
import type { ReadStream, WriteStream } from 'node:tty'

import { ensureKeypressEvents } from './keypress.js'
import { makeFrame, renderResumableList } from './render.js'
import type { ResumableRun } from './runs.js'
import { describeRunStatus } from './runs.js'
import type { Theme } from './theme.js'

export type ResumePickerResult =
  | { ok: true; run: ResumableRun }
  | { ok: false; code: number; message: string }

export interface ResumePickerOptions {
  runs: ResumableRun[]
  theme: Theme
  input?: ReadStream
  output?: WriteStream
}

export async function pickResumableRun(options: ResumePickerOptions): Promise<ResumePickerResult> {
  const input = options.input ?? defaultInput
  const output = options.output ?? defaultOutput
  const theme = options.theme

  if (options.runs.length === 0) {
    output.write(renderResumableList([], theme))
    return { ok: false, code: 1, message: 'No resumable runs.' }
  }

  if (!input.isTTY || !output.isTTY) {
    output.write(renderResumableList(options.runs, theme))
    return {
      ok: false,
      code: 64,
      message: 'Pass a run id to resume non-interactively.',
    }
  }

  return new Promise<ResumePickerResult>((resolve) => {
    let selected = 0
    const frame = makeFrame(output)

    ensureKeypressEvents(input)
    const hadRawMode = input.isRaw
    input.setRawMode(true)
    input.resume()
    output.write('\x1b[?25l')

    const cleanup = (): void => {
      input.off('keypress', onKeypress)
      input.setRawMode(hadRawMode)
      input.pause()
      output.write('\x1b[?25h')
    }

    const rerender = (): void => {
      const lines: string[] = []
      lines.push(theme.bold('Resume which run?'))
      lines.push('')
      for (let i = 0; i < options.runs.length; i += 1) {
        const run = options.runs[i]!
        const tag = describeRunStatus(run.status)
        const colorTag = run.status === 'waiting_for_capacity' ? theme.yellow(tag) : theme.dim(tag)
        const marker = i === selected ? theme.cyan('>') : ' '
        const id = i === selected ? theme.cyan(run.id) : run.id
        lines.push(`${marker} ${id}  ${colorTag}`)
        if (run.currentTaskId) {
          const title = run.currentTaskTitle ? `: ${run.currentTaskTitle}` : ''
          lines.push(`    ${theme.dim('task:')} ${run.currentTaskId}${title}`)
        }
        if (run.reason) {
          lines.push(`    ${theme.dim('reason:')} ${run.reason}`)
        }
      }
      lines.push('')
      const helper = theme.dim('Up/Down to choose, Enter to resume, Esc to cancel.')
      lines.push(helper)
      // Anchor the cursor at the bottom helper line; the picker has no
      // editable text. lines is guaranteed non-empty above (we always
      // push at least the title), so cursorRow = lines.length - 1 is safe.
      frame.draw(lines, lines.length - 1, helper.length)
    }

    const finish = (result: ResumePickerResult): void => {
      cleanup()
      frame.clear()
      resolve(result)
    }

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean; sequence?: string }): void => {
      if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
        finish({ ok: false, code: 130, message: 'Selection cancelled.' })
        return
      }
      if (key.name === 'return') {
        finish({ ok: true, run: options.runs[selected]! })
        return
      }
      if (key.name === 'up') {
        selected = Math.max(0, selected - 1)
        rerender()
        return
      }
      if (key.name === 'down') {
        selected = Math.min(options.runs.length - 1, selected + 1)
        rerender()
      }
    }

    input.on('keypress', onKeypress)
    rerender()
  })
}
