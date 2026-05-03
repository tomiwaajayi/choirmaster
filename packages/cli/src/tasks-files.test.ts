import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  completeTasksJsonReferences,
  invalidateTasksFilesCache,
  listTasksFiles,
  searchTasksFiles,
} from './tasks-files.js'

const roots: string[] = []

beforeEach(() => {
  invalidateTasksFilesCache()
})

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  invalidateTasksFilesCache()
})

describe('listTasksFiles', () => {
  it('returns empty when there is no .choirmaster/tasks dir', () => {
    const root = setupRepo()
    expect(listTasksFiles(root)).toEqual([])
  })

  it('finds .tasks.json files under .choirmaster/tasks recursively', () => {
    const root = setupRepo()
    writeTask(root, 'example.tasks.json')
    writeTask(root, 'docs/migration.tasks.json')
    writeTask(root, 'external/tmp-1234.tasks.json')

    const paths = listTasksFiles(root).map((f) => f.path).sort()
    expect(paths).toEqual([
      '.choirmaster/tasks/docs/migration.tasks.json',
      '.choirmaster/tasks/example.tasks.json',
      '.choirmaster/tasks/external/tmp-1234.tasks.json',
    ])
  })

  it('skips dotfiles and the planner scratch directory', () => {
    const root = setupRepo()
    writeTask(root, 'real.tasks.json')
    // Files inside a dotted directory should be skipped.
    mkdirSync(join(root, '.choirmaster/tasks/.tmp'), { recursive: true })
    writeFileSync(
      join(root, '.choirmaster/tasks/.tmp/scratch.tasks.json'),
      JSON.stringify([]),
    )

    const paths = listTasksFiles(root).map((f) => f.path)
    expect(paths).toEqual(['.choirmaster/tasks/real.tasks.json'])
  })

  it('sorts newest first by mtime', () => {
    const root = setupRepo()
    writeTask(root, 'older.tasks.json')
    writeTask(root, 'newer.tasks.json')
    setMtime(root, '.choirmaster/tasks/older.tasks.json', Date.now() / 1000 - 1000)
    setMtime(root, '.choirmaster/tasks/newer.tasks.json', Date.now() / 1000)

    const paths = listTasksFiles(root).map((f) => f.path)
    expect(paths[0]).toBe('.choirmaster/tasks/newer.tasks.json')
    expect(paths[1]).toBe('.choirmaster/tasks/older.tasks.json')
  })

  it('strips ANSI from filenames at the source', () => {
    const root = setupRepo()
    writeTask(root, 'evil\x1b[2Jname.tasks.json')

    const paths = listTasksFiles(root).map((f) => f.path)
    expect(paths.length).toBe(1)
    expect(paths[0]).not.toContain('\x1b')
    expect(paths[0]).toContain('evilname.tasks.json')
  })
})

describe('searchTasksFiles', () => {
  it('matches by basename without the .tasks.json suffix', () => {
    const root = setupRepo()
    writeTask(root, 'add-rate-limits.tasks.json')
    writeTask(root, 'docs/migration.tasks.json')

    const matches = searchTasksFiles('migration', root).map((f) => f.path)
    expect(matches).toEqual(['.choirmaster/tasks/docs/migration.tasks.json'])
  })

  it('matches by full path', () => {
    const root = setupRepo()
    writeTask(root, 'add-rate-limits.tasks.json')
    writeTask(root, 'docs/migration.tasks.json')

    const matches = searchTasksFiles('docs/', root).map((f) => f.path)
    expect(matches).toEqual(['.choirmaster/tasks/docs/migration.tasks.json'])
  })

  it('returns all entries (newest first) when the query is empty', () => {
    const root = setupRepo()
    writeTask(root, 'a.tasks.json')
    writeTask(root, 'b.tasks.json')

    const matches = searchTasksFiles('', root)
    expect(matches.length).toBe(2)
  })
})

describe('completeTasksJsonReferences', () => {
  it('returns @-prefixed completions for /run', () => {
    const root = setupRepo()
    writeTask(root, 'example.tasks.json')

    const completions = completeTasksJsonReferences('@ex', root)
    expect(completions).toEqual(['@.choirmaster/tasks/example.tasks.json'])
  })

  it('returns nothing for non-@ inputs', () => {
    const root = setupRepo()
    writeTask(root, 'example.tasks.json')

    expect(completeTasksJsonReferences('example', root)).toEqual([])
    expect(completeTasksJsonReferences('', root)).toEqual([])
  })
})

describe('cache', () => {
  it('honors explicit invalidation', () => {
    const root = setupRepo()
    writeTask(root, 'a.tasks.json')
    expect(listTasksFiles(root).map((f) => f.path)).toEqual([
      '.choirmaster/tasks/a.tasks.json',
    ])

    writeTask(root, 'b.tasks.json')
    // Before invalidation the cache hides the new file.
    expect(listTasksFiles(root).map((f) => f.path).sort()).toEqual([
      '.choirmaster/tasks/a.tasks.json',
    ])

    invalidateTasksFilesCache(root)
    expect(listTasksFiles(root).map((f) => f.path).sort()).toEqual([
      '.choirmaster/tasks/a.tasks.json',
      '.choirmaster/tasks/b.tasks.json',
    ])
  })
})

function setupRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'choir-tasks-files-'))
  roots.push(root)
  sh('git init -b main', root)
  sh('git config user.email test@example.com', root)
  sh('git config user.name "Test"', root)
  sh('git commit -m initial --allow-empty', root)
  return root
}

function writeTask(root: string, relPath: string): void {
  const full = join(root, '.choirmaster/tasks', relPath)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, JSON.stringify([]))
}

function setMtime(root: string, relPath: string, epochSeconds: number): void {
  utimesSync(join(root, relPath), epochSeconds, epochSeconds)
}

function sh(command: string, cwd: string): void {
  const result = spawnSync(command, { cwd, shell: true, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`command failed: ${command}\n${result.stderr || result.stdout}`)
  }
}
