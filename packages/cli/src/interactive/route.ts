/**
 * Pure routing layer for the shell.
 *
 * `resolveShellLine` parses one line of input, looks up the matching
 * command, opens any required picker, and returns the argv that should
 * be passed to the top-level CLI dispatcher (or a special action like
 * `help` / `exit` / `noop`).
 *
 * Pickers are injected as functions so tests can drive the routing
 * layer without spinning up real raw-mode pickers.
 */

import type { MarkdownPickerResult } from '../markdown-picker.js'
import { pickMarkdownFile } from '../markdown-picker.js'
import { resolveProjectRoot } from '../project-root.js'
import type { RunPickerResult } from '../run-picker.js'
import { pickRunArtifact } from '../run-picker.js'

import { findShellCommand } from './commands.js'
import { parseInteractiveLine } from './parser.js'
import type { ResumePickerResult } from './resume-picker.js'
import { pickResumableRun as defaultPickResumableRun } from './resume-picker.js'
import type { ResumableRun } from './runs.js'
import { listResumableRuns } from './runs.js'
import type { Theme } from './theme.js'

export type ShellAction =
  | { kind: 'dispatch'; argv: string[] }
  | { kind: 'help' }
  | { kind: 'exit' }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled'; message?: string }
  | { kind: 'no-resumable-runs' }

export interface ShellRouteDeps {
  theme: Theme
  /** Picker for /plan: markdown only. */
  pickMarkdown?: (cwd: string, title: string) => Promise<MarkdownPickerResult>
  /** Picker for /run: tasks.json + markdown grouped. */
  pickRunTarget?: (cwd: string, title: string) => Promise<RunPickerResult>
  pickResume?: (runs: ResumableRun[], theme: Theme) => Promise<ResumePickerResult>
  listRuns?: (cwd: string) => ResumableRun[]
}

export async function resolveShellLine(
  line: string,
  cwd: string,
  deps: ShellRouteDeps,
): Promise<ShellAction> {
  const parsed = parseInteractiveLine(line)
  if (parsed.kind === 'empty') return { kind: 'empty' }
  if (parsed.kind === 'error') return { kind: 'error', message: parsed.message }

  const command = findShellCommand(parsed.command)
  if (!command) {
    return { kind: 'error', message: `Unknown command: ${parsed.command}.` }
  }
  if (command.name === '/help') return { kind: 'help' }
  if (command.name === '/exit') return { kind: 'exit' }

  if (command.name === '/run') {
    return resolveRun(parsed.args, cwd, deps)
  }
  if (command.name === '/plan') {
    return resolvePlan(parsed.args, cwd, deps)
  }
  if (command.name === '/resume') {
    return resolveResume(parsed.args, cwd, deps)
  }

  const argv = command.toCliArgs?.(parsed.args)
  if (!argv) return { kind: 'cancelled' }
  return { kind: 'dispatch', argv }
}

async function resolveRun(
  args: string[],
  cwd: string,
  deps: ShellRouteDeps,
): Promise<ShellAction> {
  if (findPositional(args)) {
    return { kind: 'dispatch', argv: ['run', ...args] }
  }
  // /run with no positional opens the run picker, which surfaces both
  // generated task contracts (`*.tasks.json`) and markdown plans. The
  // dispatcher's behavior depends purely on the file extension: a
  // .tasks.json runs as-is; a .md plans-then-runs.
  const picker = deps.pickRunTarget ?? realPickRunTarget
  const picked = await picker(cwd, 'Select a run target')
  if (!picked.ok) return { kind: 'cancelled', message: picked.message }
  return { kind: 'dispatch', argv: ['run', picked.path, ...args] }
}

async function resolvePlan(
  args: string[],
  cwd: string,
  deps: ShellRouteDeps,
): Promise<ShellAction> {
  if (findPositional(args)) {
    return { kind: 'dispatch', argv: ['plan', ...args] }
  }
  // /plan operates on markdown plans. The picker stays markdown-only;
  // selecting a tasks.json here would be a no-op (you can't re-plan a
  // contract).
  const picker = deps.pickMarkdown ?? realPickMarkdown
  const picked = await picker(cwd, 'Select a markdown plan to compile')
  if (!picked.ok) return { kind: 'cancelled', message: picked.message }
  return { kind: 'dispatch', argv: ['plan', picked.path, ...args] }
}

async function resolveResume(
  args: string[],
  cwd: string,
  deps: ShellRouteDeps,
): Promise<ShellAction> {
  // Route through `cm run --resume <id>` rather than the bare top-level
  // `--resume` so that flags the user typed (--reuse-worktree,
  // --continue-on-blocked, --no-auto-merge) are honored. The bare form
  // accepts only the run id; the run command parses every flag.
  if (findPositional(args)) {
    const id = findPositional(args)!
    const flags = args.filter((arg) => arg !== id)
    // Auto-attach skip-blocked flags for typed `/resume <id>` when the
    // run is mixed (blocked task in front of pending work). Matches the
    // picker path so a user who types the id from memory gets the same
    // behavior as one who picks from the list. listResumableRuns
    // already validates the path and computes skipBlocked from state.
    const list = deps.listRuns ?? listResumableRuns
    const found = list(resolveProjectRoot(cwd)).find((r) => r.id === id)
    const extra: string[] = []
    if (found?.skipBlocked) {
      if (!flags.includes('--continue-on-blocked')) extra.push('--continue-on-blocked')
      if (!flags.includes('--reuse-worktree')) extra.push('--reuse-worktree')
    }
    return { kind: 'dispatch', argv: ['run', '--resume', id, ...flags, ...extra] }
  }

  const list = deps.listRuns ?? listResumableRuns
  // Resolve the git project root before scanning. The user can open
  // `cm` from any subdirectory; runs always live under the repo root,
  // not the cwd. Without this, the header (which already resolves the
  // root) and the picker disagree on what's resumable.
  const runs = list(resolveProjectRoot(cwd))
  if (runs.length === 0) {
    return { kind: 'no-resumable-runs' }
  }
  const picker = deps.pickResume ?? ((rs, th) => defaultPickResumableRun({ runs: rs, theme: th }))
  const picked = await picker(runs, deps.theme)
  if (!picked.ok) return { kind: 'cancelled', message: picked.message }
  // Carry forward any flags the user typed alongside `/resume`. When
  // the chosen run is "skip-blocked" (a blocked task in front of
  // pending work), auto-attach the flags the runtime needs to walk
  // past the blocked task. Don't double-attach if the user already
  // typed them.
  const extra: string[] = []
  if (picked.run.skipBlocked) {
    if (!args.includes('--continue-on-blocked')) extra.push('--continue-on-blocked')
    if (!args.includes('--reuse-worktree')) extra.push('--reuse-worktree')
  }
  return { kind: 'dispatch', argv: ['run', '--resume', picked.run.id, ...args, ...extra] }
}

// `realPick*` are the production picker implementations the route
// layer falls back to when no test-injected picker is supplied. The
// "real" naming distinguishes them from caller-supplied stubs without
// implying a fallback semantics they don't have.
async function realPickMarkdown(cwd: string, title: string): Promise<MarkdownPickerResult> {
  return pickMarkdownFile({ cwd, title })
}

async function realPickRunTarget(cwd: string, title: string): Promise<RunPickerResult> {
  return pickRunArtifact({ cwd, title })
}

/**
 * Flags that consume the next argument as their value. The shell's
 * routing layer needs to know about these so that the positional
 * detector doesn't pick up "/plan --output foo.json" and treat
 * "foo.json" as a plan path. Keep in sync with the readFlagValue
 * call sites in `index.ts`.
 */
const FLAGS_WITH_VALUE = new Set(['--output', '--from', '--cwd', '--resume'])

function findPositional(args: string[]): string | undefined {
  const endOfOptions = args.indexOf('--')
  if (endOfOptions !== -1) {
    return args.slice(endOfOptions + 1).find(Boolean)
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg.startsWith('-')) {
      if (FLAGS_WITH_VALUE.has(arg)) i += 1
      continue
    }
    return arg
  }
  return undefined
}
