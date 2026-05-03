/**
 * Interactive shell entry point.
 *
 * Owns the read-dispatch-redraw loop. The actual command logic lives in
 * the existing top-level CLI dispatcher (`main(argv)` in ../index.ts);
 * this module just translates slash commands into argv (via
 * `resolveShellLine`) and runs the result.
 *
 * Sets `_CHOIRMASTER_INTERACTIVE=1` for the lifetime of the shell via
 * `pushInteractiveHintScope` so downstream commands can swap their
 * "Next: cm run ..." hints for the shell-native "Next: /run ..." form.
 * The hint-style module owns env-var lifecycle so nested scopes (and
 * test races) restore correctly.
 */

import { stdout as defaultOutput } from 'node:process'

import { pushInteractiveHintScope } from '../hint-style.js'
import { invalidateMarkdownFilesCache } from '../markdown-ref.js'

import { resetPendingInputBuffer, readLineWithSuggestions } from './input.js'
import { parseInteractiveLine } from './parser.js'
import { loadRepoContext } from './repo-context.js'
import {
  renderBanner,
  renderContextLine,
  renderHelp,
  renderResumableList,
} from './render.js'
import { resolveShellLine } from './route.js'
import { computeSuggestions, filterSlashCommands, tokenUnderCursor } from './suggestions.js'
import { makeTheme } from './theme.js'

export interface InteractiveCommandArgs {
  dispatch: (args: string[]) => Promise<number>
  cwd?: string
}

export async function interactiveCommand(args: InteractiveCommandArgs): Promise<number> {
  const cwd = args.cwd ?? process.cwd()
  const output = defaultOutput
  const theme = makeTheme(output)

  const releaseHintScope = pushInteractiveHintScope()

  try {
    const initialContext = await loadRepoContext(cwd)
    output.write(renderBanner(initialContext, theme))

    while (true) {
      const result = await readLineWithSuggestions({
        prompt: 'cm> ',
        cwd,
        theme,
      })

      if (result.kind === 'interrupt' || result.kind === 'eof') {
        output.write(theme.dim('Bye.\n'))
        return 0
      }

      const action = await resolveShellLine(result.line, cwd, { theme })

      if (action.kind === 'empty') continue
      if (action.kind === 'error') {
        output.write(theme.red(action.message) + ` Type ${theme.cyan('/help')}.\n\n`)
        continue
      }
      if (action.kind === 'help') {
        output.write(renderHelp(theme) + '\n')
        continue
      }
      if (action.kind === 'exit') {
        output.write(theme.dim('Bye.\n'))
        return 0
      }
      if (action.kind === 'cancelled') {
        if (action.message) output.write(theme.dim(action.message) + '\n\n')
        continue
      }
      if (action.kind === 'no-resumable-runs') {
        output.write(renderResumableList([], theme))
        continue
      }

      try {
        await args.dispatch(action.argv)
      }
      catch (err) {
        // Dispatch threw. Surface the error to the user without
        // bringing the shell down; they can try again or /exit.
        const message = err instanceof Error ? err.message : String(err)
        output.write(theme.red(`Command failed: ${message}`) + '\n')
      }
      // /draft and /plan can create new markdown files; invalidate the
      // cached file list so the next /run @ shows the new plan.
      invalidateMarkdownFilesCache(cwd)
      output.write('\n')

      // Refresh the context line so dirty/resumable counts update
      // without a full banner reprint.
      const ctx = await loadRepoContext(cwd)
      output.write(renderContextLine(ctx, theme) + '\n\n')
    }
  }
  finally {
    releaseHintScope()
    // A multi-line paste interrupted by /exit could leave queued lines
    // in the module-level paste buffer. Drop them so a fresh `cm`
    // doesn't inherit input from a prior shell session.
    resetPendingInputBuffer()
  }
}

// ── Backwards-compatible exports preserved for external callers/tests ──

export { parseInteractiveLine }

/**
 * Legacy completion entry retained so the previous Tab-completer test
 * surface (and any external integrators) keep working. Returns
 * shell-completion-style tuples.
 */
export function completeInteractiveLine(line: string, cwd: string): [string[], string] {
  const at = tokenUnderCursor(line, line.length)
  if (at?.kind === '@') {
    const result = computeSuggestions(line, line.length, cwd)
    if (result) return [result.items.map((item) => item.value), at.token]
    return [[], at.token]
  }
  if (at?.kind === '/') {
    const result = computeSuggestions(line, line.length, cwd)
    if (result) return [result.items.map((item) => item.value), at.token]
    return [filterSlashCommands(at.token).map((item) => item.value), at.token]
  }
  return [[], line]
}
