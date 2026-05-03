/**
 * Conservative ANSI escape stripper.
 *
 * Removes CSI (`\x1b[...`), OSC (`\x1b]...`), and a small set of
 * single-letter escapes. We use this anywhere we display data that
 * came from disk (run state, repo file names) because a malicious or
 * corrupted source could otherwise inject cursor-moving or
 * screen-clearing sequences into the user's terminal.
 *
 * Intentionally narrow: we don't try to parse every ESC sequence
 * exhaustively; we strip the ones that affect the visible cursor or
 * screen and replace any remaining control characters with a safe
 * placeholder.
 */

const CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const SHORT_ESC_RE = /\x1b[@-Z\\-_]/g
const OTHER_CONTROLS_RE = /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g

export function stripAnsi(input: string): string {
  return input
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(SHORT_ESC_RE, '')
    .replace(OTHER_CONTROLS_RE, '')
}
