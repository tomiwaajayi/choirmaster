/**
 * In-CLI picker for `/run` (and `cm run` with no args). Lists generated
 * task contracts (`*.tasks.json`) at the top, sorted newest-first, then
 * markdown plans below. The split reflects how `/run` actually works:
 *
 *   - tasks.json target -> runs the contract as-is, no re-planning.
 *   - markdown target   -> runs the planner first, then runs the
 *                          generated contract.
 *
 * The picker tells the user which mode they're picking via a per-row
 * tag, so an unintentional re-plan never happens by accident.
 */

import { stdin as defaultInput, stdout as defaultOutput } from 'node:process'
import { clearScreenDown, cursorTo, emitKeypressEvents } from 'node:readline'
import type { ReadStream, WriteStream } from 'node:tty'

import { listMarkdownFiles, searchMarkdownFiles } from './markdown-ref.js'
import { listTasksFiles, searchTasksFiles } from './tasks-files.js'

export type RunArtifactKind = 'tasks' | 'markdown'

export interface RunArtifactSelection {
  path: string
  kind: RunArtifactKind
}

export type RunPickerResult =
  | { ok: true; path: string; kind: RunArtifactKind }
  | { ok: false; code: number; message: string }

export interface RunPickerOptions {
  cwd: string
  initialQuery?: string
  title?: string
  input?: ReadStream
  output?: WriteStream
}

interface PickerEntry {
  path: string
  kind: RunArtifactKind
}

export async function pickRunArtifact(options: RunPickerOptions): Promise<RunPickerResult> {
  const input = options.input ?? defaultInput
  const output = options.output ?? defaultOutput

  if (!hasAnyArtifacts(options.cwd)) {
    return {
      ok: false,
      code: 1,
      message: 'No task contracts or markdown plans found. Create a plan with `cm draft "your goal"`, then `cm plan <plan.md>`.',
    }
  }

  if (!input.isTTY || !output.isTTY) {
    return {
      ok: false,
      code: 64,
      message: 'No run target was selected. Pass <plan.md|tasks.json>, pass an exact @reference, or run this command in an interactive terminal.',
    }
  }

  return new Promise<RunPickerResult>((resolve) => {
    let query = (options.initialQuery ?? '').replace(/^@/, '')
    let selected = 0
    let renderedLines = 0
    const title = options.title ?? 'Select a run target'

    emitKeypressEvents(input)
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

    const matches = (): PickerEntry[] => {
      const found = searchEntries(query, options.cwd, 10)
      if (selected >= found.length) selected = Math.max(0, found.length - 1)
      return found
    }

    const rerender = (): void => {
      if (renderedLines > 0) output.write(`\x1b[${renderedLines}A`)
      cursorTo(output, 0)
      clearScreenDown(output)

      const found = matches()
      const lines = [
        title,
        '',
        `Search: ${query}`,
        '',
      ]

      if (found.length === 0) {
        lines.push('  No targets match. Keep typing, Backspace to edit, Esc to cancel.')
      }
      else {
        lines.push('Use Up/Down to choose, Enter to select, Esc to cancel.')
        lines.push('  task contracts run as planned; markdown plans re-plan first.')
        lines.push('')
        for (let i = 0; i < found.length; i += 1) {
          const entry = found[i]!
          const marker = i === selected ? '>' : ' '
          const tag = entry.kind === 'tasks' ? '[tasks]' : '[plan] '
          lines.push(`${marker} ${tag} ${entry.path}`)
        }
      }

      output.write(`${lines.join('\n')}\n`)
      renderedLines = lines.length
    }

    const finish = (result: RunPickerResult): void => {
      cleanup()
      if (renderedLines > 0) {
        output.write(`\x1b[${renderedLines}A`)
        cursorTo(output, 0)
        clearScreenDown(output)
      }
      if (result.ok) {
        const tag = result.kind === 'tasks' ? 'tasks' : 'plan'
        output.write(`Selected (${tag}): ${result.path}\n`)
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
        const entry = found[selected]
        if (entry) finish({ ok: true, path: entry.path, kind: entry.kind })
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

function hasAnyArtifacts(cwd: string): boolean {
  return listTasksFiles(cwd).length > 0 || listMarkdownFiles(cwd).length > 0
}

export function searchEntries(query: string, cwd: string, limit: number): PickerEntry[] {
  // Tasks files first (sorted by mtime in listTasksFiles), then markdown
  // (sorted by name). Within each group we cap at `limit` so a repo
  // with many markdown files doesn't drown out the tasks group.
  const tasks = searchTasksFiles(query, cwd, limit)
    .map((t): PickerEntry => ({ path: t.path, kind: 'tasks' }))
  const remaining = Math.max(0, limit - tasks.length)
  const markdown = remaining === 0
    ? []
    : searchMarkdownFiles(query, cwd, remaining)
        .map((path): PickerEntry => ({ path, kind: 'markdown' }))
  return [...tasks, ...markdown]
}
