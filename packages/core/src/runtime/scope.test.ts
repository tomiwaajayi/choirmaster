import { describe, expect, it } from 'vitest'
import { __test, checkScope, effectiveScope } from './scope.js'

const { matchesGlob } = __test

describe('matchesGlob', () => {
  it('matches literal paths', () => {
    expect(matchesGlob('a/b/c.ts', 'a/b/c.ts')).toBe(true)
    expect(matchesGlob('a/b/c.ts', 'a/b/d.ts')).toBe(false)
  })

  it('matches single * inside a segment', () => {
    expect(matchesGlob('app/foo.vue', 'app/*.vue')).toBe(true)
    expect(matchesGlob('app/foo/bar.vue', 'app/*.vue')).toBe(false)
  })

  it('matches ** across segments', () => {
    expect(matchesGlob('app/components/foo.vue', 'app/**/*.vue')).toBe(true)
    expect(matchesGlob('app/components/sub/foo.vue', 'app/**/*.vue')).toBe(true)
    expect(matchesGlob('app/foo.vue', 'app/**/*.vue')).toBe(true)
  })

  it('handles parentheses literally', () => {
    expect(matchesGlob('app/pages/(app)/clients/index.vue', 'app/pages/(app)/**')).toBe(true)
    expect(matchesGlob('app/pages/(public)/index.vue', 'app/pages/(app)/**')).toBe(false)
  })
})

describe('checkScope', () => {
  it('flags files outside allowed_paths', () => {
    const violations = checkScope({
      changedFiles: ['app/foo.vue', 'server/secret.ts'],
      allowedPaths: ['app/**'],
      forbiddenPaths: [],
    })
    expect(violations).toEqual([{ file: 'server/secret.ts', kind: 'not_allowed' }])
  })

  it('forbidden_paths beat allowed_paths', () => {
    const violations = checkScope({
      changedFiles: ['app/components/AppPreview.vue'],
      allowedPaths: ['app/**'],
      forbiddenPaths: ['app/components/AppPreview.vue'],
    })
    expect(violations).toHaveLength(1)
    expect(violations[0]?.kind).toBe('forbidden')
    expect(violations[0]?.matchedForbidden).toBe('app/components/AppPreview.vue')
  })

  it('returns empty when every file is allowed and none forbidden', () => {
    const violations = checkScope({
      changedFiles: ['app/a.vue', 'app/b.vue'],
      allowedPaths: ['app/**'],
      forbiddenPaths: ['server/**'],
    })
    expect(violations).toEqual([])
  })
})

describe('effectiveScope', () => {
  it('unions project forbidden globs with the task', () => {
    const result = effectiveScope(
      {
        id: 'TASK-01',
        title: 't',
        branch: 'b',
        worktree: 'w',
        allowed_paths: ['app/**'],
        forbidden_paths: ['app/components/AppX.vue'],
        gates: [],
        definition_of_done: [],
        attempts: 0,
        max_attempts: 4,
        review_iterations: 0,
        max_review_iterations: 3,
        status: 'pending',
      },
      ['.env', 'package.json'],
    )
    expect(result.forbidden).toEqual(
      expect.arrayContaining(['.env', 'package.json', 'app/components/AppX.vue']),
    )
    expect(result.allowed).toEqual(['app/**'])
  })

  it('deduplicates entries that appear in both sources', () => {
    const result = effectiveScope(
      {
        id: 'TASK-01',
        title: 't',
        branch: 'b',
        worktree: 'w',
        allowed_paths: [],
        forbidden_paths: ['.env', '.github/**'],
        gates: [],
        definition_of_done: [],
        attempts: 0,
        max_attempts: 4,
        review_iterations: 0,
        max_review_iterations: 3,
        status: 'pending',
      },
      ['.env', 'package.json'],
    )
    expect(result.forbidden).toHaveLength(3)
  })
})
