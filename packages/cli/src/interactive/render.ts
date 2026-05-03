/**
 * Frame helpers for the interactive shell. No state.
 *
 * `renderBanner` and `renderHelp` produce strings that the entry point
 * writes once. The input loop owns the live prompt frame: it builds
 * lines via `renderSuggestionList` and writes them through the same
 * cursor-management helpers (`drawFrame`, `clearFrame`).
 */

import { clearScreenDown, cursorTo } from 'node:readline'
import type { WriteStream } from 'node:tty'

import { stripAnsi } from '../strip-ansi.js'

import { SHELL_COMMANDS } from './commands.js'
import type { RepoContext } from './repo-context.js'
import type { ResumableRun } from './runs.js'
import { describeRunStatus } from './runs.js'
import type { Suggestion } from './suggestions.js'
import type { Theme } from './theme.js'

export function renderBanner(context: RepoContext, theme: Theme): string {
  const lines: string[] = []
  lines.push(theme.bold('ChoirMaster'))
  lines.push(renderContextLine(context, theme))
  lines.push(theme.dim('Type / for commands, @ for plans, /help for help, /exit to quit.'))
  return `${lines.join('\n')}\n\n`
}

export function renderContextLine(context: RepoContext, theme: Theme): string {
  const parts: string[] = []
  parts.push(`${theme.dim('repo:')} ${context.repoName}`)
  if (context.branch) parts.push(`${theme.dim('branch:')} ${context.branch}`)
  if (context.base) parts.push(`${theme.dim('base:')} ${context.base}`)
  if (context.dirty) parts.push(theme.yellow('dirty'))
  if (context.resumableCount > 0) {
    const word = context.resumableCount === 1 ? 'run' : 'runs'
    parts.push(theme.cyan(`${context.resumableCount} resumable ${word}`))
  }
  return parts.join('  ')
}

export function renderHelp(theme: Theme): string {
  const lines: string[] = []
  lines.push(theme.bold('Commands'))
  lines.push('')
  const visible = SHELL_COMMANDS
  const padTo = Math.max(...visible.map((cmd) => cmd.name.length))
  for (const cmd of visible) {
    const name = cmd.name.padEnd(padTo, ' ')
    lines.push(`  ${theme.cyan(name)}  ${cmd.summary}`)
  }
  lines.push('')
  lines.push(theme.bold('Examples'))
  lines.push('')
  lines.push(theme.dim('  /draft add email sharing'))
  lines.push(theme.dim('  /run @example'))
  lines.push(theme.dim('  /run                  (open the markdown picker)'))
  lines.push(theme.dim('  /resume               (list resumable runs)'))
  lines.push('')
  lines.push(theme.bold('Tips'))
  lines.push('')
  lines.push(theme.dim('  Use Up/Down to move through suggestions. Enter to accept. Esc to dismiss.'))
  lines.push(theme.dim('  Outside the shell: cm --resume <run-id>'))
  return `${lines.join('\n')}\n`
}

export function buildSuggestionLines(
  suggestions: Suggestion[] | undefined,
  highlighted: number | undefined,
  caption: string | undefined,
  theme: Theme,
): string[] {
  if (!suggestions || suggestions.length === 0) return []
  const lines: string[] = []
  if (caption) lines.push(theme.dim(caption))
  const max = 8
  const view = suggestions.slice(0, max)
  for (let i = 0; i < view.length; i += 1) {
    const item = view[i]!
    const selected = i === highlighted
    const marker = selected ? theme.cyan('>') : ' '
    const value = selected ? theme.cyan(item.value) : item.value
    const hint = item.hint ? `  ${theme.dim(item.hint)}` : ''
    lines.push(`${marker} ${value}${hint}`)
  }
  if (suggestions.length > view.length) {
    lines.push(theme.dim(`  +${suggestions.length - view.length} more...`))
  }
  return lines
}

export function renderResumableList(runs: ResumableRun[], theme: Theme): string {
  if (runs.length === 0) {
    return [
      theme.bold('No resumable runs.'),
      '',
      theme.dim('Start one with /run <plan.md|@query>.'),
    ].join('\n') + '\n'
  }
  const lines: string[] = []
  lines.push(theme.bold('Resumable runs'))
  lines.push('')
  for (let i = 0; i < runs.length; i += 1) {
    const run = runs[i]!
    const tag = describeRunStatus(run.status)
    const colorTag = run.status === 'waiting_for_capacity' ? theme.yellow(tag) : theme.dim(tag)
    lines.push(`  ${i + 1}. ${run.id}  ${colorTag}`)
    if (run.currentTaskId) {
      const title = run.currentTaskTitle ? `: ${run.currentTaskTitle}` : ''
      lines.push(`     ${theme.dim('task:')} ${run.currentTaskId}${title}`)
    }
    if (run.reason) {
      lines.push(`     ${theme.dim('reason:')} ${run.reason}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * Frame primitive: keeps a "live" frame of N logical lines and lets the
 * caller redraw it in place. The frame is wrap-aware: a logical line
 * wider than the terminal is rendered across multiple physical rows,
 * and the rewind/clear math accounts for those extra rows. Without
 * that, a long line would leave its wrapped tail on screen as visual
 * garbage on the next draw.
 *
 * Used by the input loop (prompt + suggestion stack), pickers, and
 * any other live UI. Plain output (command results) should be written
 * after `clear()` so it scrolls past the freed-up screen region.
 */
export function makeFrame(output: WriteStream): {
  /**
   * Draw `lines` and place the terminal cursor at the visible cell
   * corresponding to logical (cursorRow, cursorCol). cursorCol may
   * exceed the terminal width; the frame translates it into physical
   * rows via `output.columns` and positions the cursor accordingly.
   */
  draw: (lines: string[], cursorRow: number, cursorCol: number) => void
  clear: () => void
} {
  // Number of physical rows above the cursor inside the frame. We
  // rewind exactly this many rows on the next draw to land on the
  // frame's top row.
  let physRowsAboveCursor = 0
  return {
    draw(lines, cursorRow, cursorCol) {
      const cols = readColumns(output)

      if (lines.length === 0) {
        rewindAndClear(output, physRowsAboveCursor)
        physRowsAboveCursor = 0
        return
      }
      const lastRow = lines.length - 1
      if (cursorRow < 0 || cursorRow > lastRow) {
        throw new RangeError(
          `makeFrame.draw: cursorRow ${cursorRow} is outside [0, ${lastRow}]`,
        )
      }
      if (cursorCol < 0) {
        throw new RangeError(`makeFrame.draw: cursorCol ${cursorCol} is negative`)
      }

      rewindAndClear(output, physRowsAboveCursor)

      output.write(lines.join('\n'))

      // If the LAST line ends exactly at the terminal-column boundary,
      // the cursor lands in pending-wrap state (delayed-wrap terminals
      // like xterm/iTerm/kitty leave it at col cols-1 with a hidden
      // "pending" flag; eager-wrap terminals advance to col 0 of the
      // next row immediately). Either way, an explicit `\r\n` here
      // forces the cursor onto a definite next-row col 0 so subsequent
      // positioning math works the same on both terminal models.
      // Internal `\n`s between logical lines already get OPOST/ONLCR
      // CR-LF translation, so they don't have this problem.
      const lastLine = lines[lines.length - 1] ?? ''
      const lastLineWidth = visibleWidth(lastLine)
      const lastLineAtBoundary = lastLineWidth > 0 && lastLineWidth % cols === 0
      if (lastLineAtBoundary) output.write('\r\n')

      // Total physical rows used by everything we just wrote.
      let totalPhys = 0
      const physOffsetOf: number[] = []
      for (const line of lines) {
        physOffsetOf.push(totalPhys)
        totalPhys += physicalRowsFor(line, cols)
      }
      // The forced \r\n at the boundary contributes one more row.
      if (lastLineAtBoundary) totalPhys += 1

      // After writing, the terminal cursor sits at the end of the last
      // physical row.
      const cursorPhysAfterWrite = totalPhys - 1

      // Translate the requested logical (row, col) into physical.
      const targetPhysRow = physOffsetOf[cursorRow]! + Math.floor(cursorCol / cols)
      const targetPhysCol = cursorCol % cols

      const upBy = cursorPhysAfterWrite - targetPhysRow
      if (upBy > 0) output.write(`\x1b[${upBy}A`)
      cursorTo(output, targetPhysCol)
      physRowsAboveCursor = targetPhysRow
    },
    clear() {
      rewindAndClear(output, physRowsAboveCursor)
      physRowsAboveCursor = 0
    },
  }
}

function rewindAndClear(output: WriteStream, rowsUp: number): void {
  if (rowsUp > 0) output.write(`\x1b[${rowsUp}A`)
  cursorTo(output, 0)
  clearScreenDown(output)
}

function readColumns(output: WriteStream): number {
  const cols = (output as { columns?: number }).columns
  if (typeof cols === 'number' && cols > 0) return cols
  return 80
}

function physicalRowsFor(line: string, cols: number): number {
  const w = visibleWidth(line)
  if (w === 0) return 1
  return Math.ceil(w / cols)
}

/** Visible cell width: strip ANSI, count UTF-16 code units. */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length
}
