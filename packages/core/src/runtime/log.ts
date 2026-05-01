/**
 * Per-task logging. Each task gets its own markdown file under the run's
 * logs directory; both single-line records and multi-line blocks are
 * appended in chronological order. The same lines also stream to stdout
 * so a `tail -f` on the log mirrors the terminal.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface TaskLogger {
  /** Append a single timestamped line. Surfaces both to file and stdout. */
  line(message: string): void
  /** Append a multi-line block with a heading. File only. */
  block(heading: string, body: string): void
  /** Append raw text without formatting. Used by streaming agents. */
  raw(text: string): void
  /** Absolute path to the log file, for callers that want to reference it. */
  readonly file: string
}

export function createTaskLogger(logsDir: string, taskId: string): TaskLogger {
  if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true })
  const file = join(logsDir, `${taskId}.md`)

  return {
    file,
    line(message) {
      const stamp = new Date().toISOString()
      appendFileSync(file, `[${stamp}] ${message}\n`)
      // eslint-disable-next-line no-console
      console.log(`[${taskId}] ${message}`)
    },
    block(heading, body) {
      const stamp = new Date().toISOString()
      appendFileSync(file, `\n## ${heading} - ${stamp}\n\n${body.trim()}\n`)
    },
    raw(text) {
      appendFileSync(file, text)
    },
  }
}

/** Ensures a directory exists; small helper used by callers that build run-local paths. */
export function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
}

/** Ensures a file's parent directory exists. */
export function ensureParent(filePath: string): void {
  ensureDir(dirname(filePath))
}
