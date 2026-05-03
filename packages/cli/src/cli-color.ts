/**
 * Tiny ANSI helpers shared by everything in the CLI that wants to
 * color one-off text. Honors `NO_COLOR` and a non-TTY stdout (so logs
 * captured to files don't get escape codes).
 *
 * The interactive shell builds a richer `theme.ts` on top of this for
 * its prompt and pickers; commands like `doctor` use the simpler
 * `colorize()` helper directly.
 */

export type CliColor = 'green' | 'yellow' | 'red' | 'cyan' | 'dim' | 'bold'

const COLOR_OPEN: Record<CliColor, string> = {
  green: '32',
  yellow: '33',
  red: '31',
  cyan: '36',
  dim: '2',
  bold: '1',
}

const COLOR_CLOSE: Record<CliColor, string> = {
  green: '39',
  yellow: '39',
  red: '39',
  cyan: '39',
  dim: '22',
  bold: '22',
}

export function useCliColor(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR
}

export function colorize(color: CliColor, text: string): string {
  if (!useCliColor()) return text
  return `\x1b[${COLOR_OPEN[color]}m${text}\x1b[${COLOR_CLOSE[color]}m`
}
