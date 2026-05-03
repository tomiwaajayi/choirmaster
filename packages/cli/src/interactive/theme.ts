/**
 * Tiny ANSI helper for the interactive shell. Honors NO_COLOR and a
 * non-TTY output stream.
 *
 * The shell builds richer composed strings (e.g. picker frames), so it
 * gets its own theme object. Single-shot CLI output (e.g. `doctor`)
 * uses the simpler `colorize()` from `cli-color.ts`.
 */

import type { WriteStream } from 'node:tty'

export interface Theme {
  bold: (s: string) => string
  dim: (s: string) => string
  cyan: (s: string) => string
  green: (s: string) => string
  yellow: (s: string) => string
  red: (s: string) => string
}

export function makeTheme(output: WriteStream): Theme {
  const enabled = output.isTTY === true && !process.env.NO_COLOR
  if (!enabled) {
    const id = (s: string): string => s
    return { bold: id, dim: id, cyan: id, green: id, yellow: id, red: id }
  }
  const wrap = (open: string, close: string) =>
    (s: string): string => `\x1b[${open}m${s}\x1b[${close}m`
  return {
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    cyan: wrap('36', '39'),
    green: wrap('32', '39'),
    yellow: wrap('33', '39'),
    red: wrap('31', '39'),
  }
}
