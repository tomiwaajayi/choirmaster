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

const TAG_LABELS = ['[tasks]', '[plan]'] as const

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
    // Two-line title: keep the headline short (always fits on a 40-col
    // narrow split), put the explanation below as a dim helper. The
    // run-picker doesn't use the wrap-aware makeFrame yet, so a wrapped
    // first line would leave residue across redraws.
    const title = options.title ?? 'Select a run target'
    const subtitle = '  (tasks: run as planned; plans: re-plan first)'

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

    /** Pure: returns the current filtered list. No state mutation. */
    const matches = (): PickerEntry[] => searchEntries(query, options.cwd, 10)

    /** Clamp `selected` into the current matches range. Call after every
     * keystroke that changes `query` or selection bounds.
     */
    const clampSelection = (found: PickerEntry[] = matches()): void => {
      if (selected >= found.length) selected = Math.max(0, found.length - 1)
    }

    const rerender = (): void => {
      if (renderedLines > 0) output.write(`\x1b[${renderedLines}A`)
      cursorTo(output, 0)
      clearScreenDown(output)

      const found = matches()
      clampSelection(found)
      const lines = [
        title,
        subtitle,
        '',
        `Search: ${query}`,
        '',
      ]

      if (found.length === 0) {
        lines.push('  No targets match this query. Backspace to edit, Esc to cancel (Enter is a no-op while no row is highlighted).')
      }
      else {
        lines.push('Use Up/Down to choose, Enter to select, Esc to cancel.')
        lines.push('')
        const tagWidth = Math.max(...TAG_LABELS.map((t) => t.length))
        for (let i = 0; i < found.length; i += 1) {
          const entry = found[i]!
          const marker = i === selected ? '>' : ' '
          const tag = (entry.kind === 'tasks' ? '[tasks]' : '[plan]').padEnd(tagWidth, ' ')
          lines.push(`${marker} ${tag}  ${entry.path}`)
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
        const found = matches()
        selected = Math.min(found.length - 1, selected + 1)
        rerender()
        return
      }
      if (key.name === 'backspace') {
        query = query.slice(0, -1)
        selected = 0
        clampSelection()
        rerender()
        return
      }
      if (str && !key.ctrl && str >= ' ') {
        query += str === '@' && query.length === 0 ? '' : str
        selected = 0
        clampSelection()
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

function searchEntries(query: string, cwd: string, limit: number): PickerEntry[] {
  // Tasks files first (sorted by score then mtime), then markdown
  // below. Cap each source individually so the picker keeps both
  // groups visible: a repo with 50 markdown plans shouldn't drown
  // out a single tasks.json the user just generated, and vice-versa.
  //
  // The trailing `slice(0, limit)` handles the odd-limit overflow
  // case: with ceil(5/2) = 3 per source, we could end up with 6
  // entries; the slice trims to the caller's exact cap.
  const perSource = Math.max(1, Math.ceil(limit / 2))
  const tasks = searchTasksFiles(query, cwd, perSource)
    .map((t): PickerEntry => ({ path: t.path, kind: 'tasks' }))
  const markdown = searchMarkdownFiles(query, cwd, perSource)
    .map((path): PickerEntry => ({ path, kind: 'markdown' }))
  return [...tasks, ...markdown].slice(0, limit)
}
