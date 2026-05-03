import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { listResumableRuns, validateRunPath } from './runs.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('listResumableRuns', () => {
  it('returns an empty list when there is no runs directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    expect(listResumableRuns(root)).toEqual([])
  })

  it('surfaces only resumable statuses (waiting, in_progress, pending); blocked is excluded', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)

    writeRun(root, 'run-completed', {
      tasks: [{ id: 'TASK-01', title: 'Done', status: 'completed' }],
    })
    writeRun(root, 'run-blocked', {
      tasks: [{
        id: 'TASK-02',
        title: 'Blocked task',
        status: 'blocked',
        blocked_reason: 'gates failed: typecheck',
      }],
    })
    writeRun(root, 'run-waiting', {
      tasks: [{
        id: 'TASK-03',
        title: 'Capacity',
        status: 'waiting_for_capacity',
        paused_phase: 'reviewer',
      }],
    })
    writeRun(root, 'run-in-progress', {
      tasks: [{ id: 'TASK-04', title: 'Mid-task', status: 'in_progress' }],
    })

    const runs = listResumableRuns(root)
    const ids = runs.map((r) => r.id).sort()
    // Blocked runs are intentionally excluded: cm --resume against a
    // blocked task hits "worktree already exists" because the runtime
    // only auto-reuses worktrees for waiting / in_progress.
    expect(ids).toEqual(['run-in-progress', 'run-waiting'])

    const waiting = runs.find((r) => r.id === 'run-waiting')!
    expect(waiting.status).toBe('waiting_for_capacity')
    expect(waiting.reason).toContain('reviewer')

    const interrupted = runs.find((r) => r.id === 'run-in-progress')!
    expect(interrupted.status).toBe('in_progress')
    expect(interrupted.reason).toContain('interrupted')
  })

  it('drops a run whose only incomplete tasks are blocked (no resumable surface)', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    writeRun(root, 'all-blocked', {
      tasks: [
        { id: 'TASK-01', status: 'completed' },
        { id: 'TASK-02', status: 'blocked', blocked_reason: 'scope violation' },
      ],
    })
    expect(listResumableRuns(root)).toEqual([])
  })

  it('drops a run when its first non-completed task is blocked', () => {
    // The runtime resume loop iterates tasks in order, skipping only
    // completed. With [blocked, pending], runtime would re-enter the
    // blocked task first and hit "worktree already exists" before ever
    // reaching the pending task. Surfacing this run as resumable would
    // mislead the user.
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    writeRun(root, 'blocked-then-pending', {
      tasks: [
        { id: 'TASK-01', status: 'blocked', blocked_reason: 'gates failed' },
        { id: 'TASK-02', title: 'Next', status: 'pending' },
      ],
    })
    expect(listResumableRuns(root)).toEqual([])
  })

  it('keeps a partially-blocked run when blocked tasks come AFTER the focus', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    writeRun(root, 'pending-then-blocked', {
      tasks: [
        { id: 'TASK-01', title: 'Next', status: 'pending' },
        { id: 'TASK-02', status: 'blocked', blocked_reason: 'gates failed' },
      ],
    })
    const runs = listResumableRuns(root)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('pending')
    expect(runs[0]!.currentTaskId).toBe('TASK-01')
  })

  it('focuses on the first non-completed task even if a later task has a richer status', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    writeRun(root, 'pending-then-waiting', {
      tasks: [
        { id: 'TASK-01', title: 'First', status: 'pending' },
        { id: 'TASK-02', status: 'waiting_for_capacity', paused_phase: 'reviewer' },
      ],
    })
    const runs = listResumableRuns(root)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('pending')
    expect(runs[0]!.currentTaskId).toBe('TASK-01')
  })

  it('sorts newest first by state.json mtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)

    writeRun(root, 'older', { tasks: [{ id: 'T', status: 'waiting_for_capacity' }] })
    writeRun(root, 'newer', { tasks: [{ id: 'T', status: 'waiting_for_capacity' }] })
    setMtime(root, 'older', Date.now() / 1000 - 1000)
    setMtime(root, 'newer', Date.now() / 1000)

    const runs = listResumableRuns(root)
    expect(runs[0]!.id).toBe('newer')
    expect(runs[1]!.id).toBe('older')
  })

  it('ignores the active sentinel directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    mkdirSync(join(root, '.choirmaster/runs/active'), { recursive: true })
    writeFileSync(
      join(root, '.choirmaster/runs/active/state.json'),
      JSON.stringify({ tasks: [{ id: 'T', status: 'waiting_for_capacity' }] }),
    )
    expect(listResumableRuns(root)).toEqual([])
  })

  it('rejects a symlinked run directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    // Real run that should be picked up.
    writeRun(root, 'real-run', {
      tasks: [{ id: 'T', status: 'waiting_for_capacity' }],
    })
    // Outside target with a state.json that LOOKS valid.
    const outside = mkdtempSync(join(tmpdir(), 'choir-runs-outside-'))
    roots.push(outside)
    writeFileSync(
      join(outside, 'state.json'),
      JSON.stringify({ tasks: [{ id: 'EVIL', status: 'waiting_for_capacity' }] }),
    )
    // Symlink runs/symlinked -> outside dir.
    mkdirSync(join(root, '.choirmaster/runs'), { recursive: true })
    symlinkSync(outside, join(root, '.choirmaster/runs/symlinked'), 'dir')

    const ids = listResumableRuns(root).map((r) => r.id)
    expect(ids).toEqual(['real-run'])
    expect(ids).not.toContain('symlinked')
  })

  it('rejects a symlinked state.json file', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    const runDir = join(root, '.choirmaster/runs/symstate')
    mkdirSync(runDir, { recursive: true })
    // Write the real state outside, then symlink runs/symstate/state.json -> outside.
    const outside = join(tmpdir(), `choir-state-${Date.now()}.json`)
    writeFileSync(
      outside,
      JSON.stringify({ tasks: [{ id: 'EVIL', status: 'waiting_for_capacity' }] }),
    )
    symlinkSync(outside, join(runDir, 'state.json'))
    try {
      expect(listResumableRuns(root)).toEqual([])
    }
    finally {
      rmSync(outside, { force: true })
    }
  })
})


describe('validateRunPath', () => {
  it('rejects path-traversal-shaped ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    expect(validateRunPath(root, '../etc')).toMatchObject({ ok: false })
    expect(validateRunPath(root, 'foo/bar')).toMatchObject({ ok: false })
    expect(validateRunPath(root, 'foo\\bar')).toMatchObject({ ok: false })
    expect(validateRunPath(root, '.hidden')).toMatchObject({ ok: false })
    expect(validateRunPath(root, '')).toMatchObject({ ok: false })
    expect(validateRunPath(root, 'active')).toMatchObject({ ok: false })
  })

  it('rejects ids containing ANSI/control bytes before any filesystem touch', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    // The runtime's id generator only ever produces [A-Za-z0-9-]+ ids,
    // so anything with an ESC, CR, NUL, or other control byte is
    // adversarial. We must reject it BEFORE doing the filesystem check
    // so that even a real on-disk directory of that shape can't
    // smuggle terminal-control bytes into the picker output.
    const cases = [
      'evil\x1b[2Jname',
      'cr\rmasked',
      'tab\tname',
      'nul\x00here',
      'space here',
      'em🎉oji',
    ]
    for (const id of cases) {
      const result = validateRunPath(root, id)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        // The reason itself must not contain raw ESC bytes either.
        expect(result.reason).not.toContain('\x1b')
        expect(result.reason).not.toContain('\x00')
      }
    }
  })

  it('rejects ANSI-bearing ids even when a real directory of that name exists', () => {
    // Defense-in-depth: even if some external tool created such a
    // directory, listResumableRuns / validateRunPath must not accept it.
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    const evilId = 'safe\x1b[2Jname'
    const dir = join(root, '.choirmaster/runs', evilId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ tasks: [{ id: 'T', status: 'waiting_for_capacity' }] }),
    )
    expect(validateRunPath(root, evilId).ok).toBe(false)
    expect(listResumableRuns(root)).toEqual([])
  })

  it('rejects a missing run directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    const result = validateRunPath(root, 'nope')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not found')
  })

  it('rejects a symlinked run directory at the typed-resume entry point', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    const outside = mkdtempSync(join(tmpdir(), 'choir-runs-outside-'))
    roots.push(outside)
    writeFileSync(
      join(outside, 'state.json'),
      JSON.stringify({ tasks: [{ id: 'EVIL', status: 'waiting_for_capacity' }] }),
    )
    mkdirSync(join(root, '.choirmaster/runs'), { recursive: true })
    symlinkSync(outside, join(root, '.choirmaster/runs/sym'), 'dir')

    const result = validateRunPath(root, 'sym')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('not a real')
  })

  it('returns absolute paths for a real run directory + state file', () => {
    const root = mkdtempSync(join(tmpdir(), 'choir-runs-'))
    roots.push(root)
    writeRun(root, 'real', {
      tasks: [{ id: 'T', status: 'waiting_for_capacity' }],
    })
    const result = validateRunPath(root, 'real')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.runDir).toBe(join(root, '.choirmaster/runs/real'))
      expect(result.statePath).toBe(join(root, '.choirmaster/runs/real/state.json'))
      expect(result.mtimeMs).toBeGreaterThan(0)
    }
  })
})

function writeRun(root: string, id: string, state: object): void {
  const dir = join(root, '.choirmaster/runs', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state))
}

function setMtime(root: string, id: string, epochSeconds: number): void {
  const path = join(root, '.choirmaster/runs', id, 'state.json')
  utimesSync(path, epochSeconds, epochSeconds)
}
