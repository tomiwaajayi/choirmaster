/**
 * Resumable-run discovery for the interactive shell.
 *
 * Reads `.choirmaster/runs/<id>/state.json` and surfaces a digest:
 * id, status (waiting_for_capacity, blocked, running, ready), the
 * current/next task, and a one-line reason. Pure on top of the
 * filesystem so tests can hit it with a temp repo.
 */

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { stripAnsi } from '../strip-ansi.js'

/**
 * Statuses surfaced by the picker. `blocked` is intentionally absent:
 * the runtime can't auto-resume a blocked task today, so we filter
 * those runs out of `listResumableRuns` rather than advertise them
 * here. If a future runtime gains a "reset and retry" path, add the
 * variant back along with the matching dispatch flag.
 */
export type ResumableRunStatus =
  | 'waiting_for_capacity'
  | 'in_progress'
  | 'pending'

export interface ResumableRun {
  id: string
  status: ResumableRunStatus
  /** Task that paused/blocked the run, or the next pending one. */
  currentTaskId?: string
  currentTaskTitle?: string
  /** Short hint about why this run is unfinished. */
  reason?: string
  /** Last-modified time of the state.json (for sorting). */
  modifiedAt: number
  /** When the run started, if known. */
  startedAt?: string
}

/**
 * Validate that `runId` is a safe leaf name and that
 * `<projectRoot>/.choirmaster/runs/<runId>/state.json` is a real
 * directory + real file (not a symlink, not a regular file pretending
 * to be the dir, etc.). Used by both `listResumableRuns` (per-entry
 * filter) and `runCommand` (top-level `cm --resume <id>` entry) so the
 * picker and the direct path apply the same hardening.
 *
 * Reasons we reject:
 * - id is empty, the active sentinel, or starts with a dot.
 * - id contains anything outside the safe-charset allowlist.
 *   The runtime's generator only ever produces `[A-Za-z0-9-]+` ids
 *   (timestamp + random base36), so legitimate ids match easily.
 *   Crucially this rejects ESC and other terminal-control bytes that
 *   would otherwise inject escape sequences when the picker prints
 *   the id back to the user. We do NOT just scrub for display: the
 *   id also flows into filesystem and state.json paths, where any
 *   special character is a hazard.
 * - The run directory is missing or is not a real directory (e.g. a
 *   symlink to an outside path).
 * - state.json is missing or is not a real regular file.
 *
 * Returned `ok: true` carries absolute paths the caller can hand to
 * read/write APIs. Reasons in the `ok: false` case are pre-scrubbed
 * so they're safe to print without further sanitization.
 */
export type RunPathValidation =
  | { ok: true; runDir: string; statePath: string; mtimeMs: number }
  | { ok: false; reason: string }

const SAFE_RUN_ID = /^[A-Za-z0-9._-]+$/

export function validateRunPath(projectRoot: string, runId: string): RunPathValidation {
  if (typeof runId !== 'string' || runId.length === 0) {
    return { ok: false, reason: 'run id must be a non-empty string' }
  }
  if (runId === 'active') {
    return { ok: false, reason: 'reserved run id' }
  }
  if (runId.startsWith('.')) {
    return { ok: false, reason: 'unsafe run id (cannot start with a dot)' }
  }
  if (!SAFE_RUN_ID.test(runId)) {
    // Strip before echoing in case the id carries terminal-control bytes.
    return {
      ok: false,
      reason: `unsafe run id: ${stripAnsi(runId).slice(0, 40)}`,
    }
  }

  const runDir = join(projectRoot, '.choirmaster/runs', runId)
  let runStat
  try {
    runStat = lstatSync(runDir)
  }
  catch {
    return { ok: false, reason: `run directory not found: .choirmaster/runs/${runId}` }
  }
  if (!runStat.isDirectory()) {
    // A symlink at this position would lstat as a symlink, not a directory.
    return { ok: false, reason: `not a real run directory: .choirmaster/runs/${runId}` }
  }

  const statePath = join(runDir, 'state.json')
  let stateStat
  try {
    stateStat = lstatSync(statePath)
  }
  catch {
    return { ok: false, reason: `state.json missing under .choirmaster/runs/${runId}` }
  }
  if (!stateStat.isFile()) {
    return { ok: false, reason: `state.json is not a regular file under .choirmaster/runs/${runId}` }
  }

  return { ok: true, runDir, statePath, mtimeMs: stateStat.mtimeMs }
}

export function listResumableRuns(projectRoot: string): ResumableRun[] {
  const runsDir = join(projectRoot, '.choirmaster/runs')

  let entries: string[]
  try {
    entries = readdirSync(runsDir)
  }
  catch {
    return []
  }

  const runs: ResumableRun[] = []
  for (const id of entries) {
    const validation = validateRunPath(projectRoot, id)
    if (!validation.ok) continue

    let parsed: unknown
    try {
      const raw = readFileSync(validation.statePath, 'utf8')
      parsed = JSON.parse(raw)
    }
    catch {
      continue
    }

    const summary = summarizeState(id, parsed, validation.mtimeMs)
    if (summary) runs.push(summary)
  }

  // Newest first. Most recent paused runs are usually what the user
  // wants to resume.
  return runs.sort((a, b) => b.modifiedAt - a.modifiedAt)
}

interface RawTask {
  id?: string
  title?: string
  status?: string
  blocked_reason?: string
  paused_phase?: string
}

interface RawState {
  id?: string
  started_at?: string
  current_task?: string | null
  tasks?: RawTask[]
}

function summarizeState(id: string, parsed: unknown, modifiedAt: number): ResumableRun | null {
  if (!parsed || typeof parsed !== 'object') return null
  const state = parsed as RawState
  const tasks = Array.isArray(state.tasks) ? state.tasks : []
  if (tasks.length === 0) return null

  // The runtime resumes by iterating tasks in order, skipping only
  // `completed`. So the actually-actioned task on `cm --resume` is the
  // first non-completed task. Anchor the picker's focus on that task,
  // not on a "best-status" search across the whole run; otherwise the
  // picker can advertise TASK-02 (pending) as resumable while the
  // runtime tries TASK-01 (blocked) first and halts before reaching
  // TASK-02.
  const firstIncomplete = tasks.find((task) => task.status !== 'completed')
  if (!firstIncomplete) return null

  // Blocked needs a reset/retry path the CLI doesn't yet expose:
  // the runtime only auto-reuses worktrees for waiting_for_capacity or
  // in_progress, so a bare `cm --resume` against a run whose first
  // non-completed task is blocked fails at sandbox setup. Drop those
  // runs from the picker; they remain visible through `printSummary`
  // at the end of the original run.
  if (firstIncomplete.status === 'blocked') return null

  let status: ResumableRunStatus
  let reason: string | undefined
  if (firstIncomplete.status === 'waiting_for_capacity') {
    status = 'waiting_for_capacity'
    reason = firstIncomplete.paused_phase
      ? `capacity hit during ${firstIncomplete.paused_phase}`
      : 'waiting for capacity'
  }
  else if (firstIncomplete.status === 'in_progress') {
    status = 'in_progress'
    reason = 'interrupted mid-task'
  }
  else {
    // pending or any unrecognized status falls into the "not started" bucket.
    status = 'pending'
    reason = 'not started'
  }

  return {
    // The id is already validated by `validateRunPath` against a strict
    // allowlist before we get here, but scrub once more on the display
    // boundary as defense-in-depth: belt + suspenders for the one
    // value that flows directly into picker frames and resume hints.
    id: stripAnsi(id),
    status,
    currentTaskId: stripDisplay(firstIncomplete.id),
    currentTaskTitle: stripDisplay(firstIncomplete.title),
    reason: stripDisplay(reason),
    modifiedAt,
    startedAt: stripDisplay(state.started_at),
  }
}

function stripDisplay(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  // state.json is normally written by the runtime, but a corrupted or
  // adversarial copy could carry ANSI escapes that move the cursor or
  // clear the screen when we render the resume picker. Defensive scrub
  // before any value flows into output.
  return stripAnsi(value)
}

export function describeRunStatus(status: ResumableRunStatus): string {
  switch (status) {
    case 'waiting_for_capacity':
      return 'waiting'
    case 'in_progress':
      return 'interrupted'
    case 'pending':
      return 'pending'
  }
}
