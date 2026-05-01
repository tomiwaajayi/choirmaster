/**
 * Read the structured JSON files agents write to communicate verdicts.
 * The implementer writes `<worktree>/.choirmaster/handoff.json` after each
 * turn; the reviewer writes `<worktree>/.choirmaster/review.json`.
 *
 * Files are removed after reading so a stale artifact from a previous turn
 * never confuses the next one. JSON shape is validated; malformed files
 * are returned as null with a reason logged so the runtime can decide
 * whether to retry or block.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Handoff, Review, ReviewIssue } from '../types.js'

export const HANDOFF_RELATIVE_PATH = '.choirmaster/handoff.json'
export const REVIEW_RELATIVE_PATH = '.choirmaster/review.json'

export interface ReadResult<T> {
  /** The validated payload, or null if the file was missing or malformed. */
  data: T | null
  /** Why parsing failed; populated only when data is null and a file was present. */
  reason?: string
}

export function readHandoff(worktreeCwd: string, expectedTaskId: string): ReadResult<Handoff> {
  return readJsonOnce(
    join(worktreeCwd, HANDOFF_RELATIVE_PATH),
    (raw) => validateHandoff(raw, expectedTaskId),
  )
}

export function readReview(worktreeCwd: string, expectedTaskId: string): ReadResult<Review> {
  return readJsonOnce(
    join(worktreeCwd, REVIEW_RELATIVE_PATH),
    (raw) => validateReview(raw, expectedTaskId),
  )
}

function readJsonOnce<T>(
  file: string,
  validate: (raw: unknown) => { ok: true, value: T } | { ok: false, reason: string },
): ReadResult<T> {
  if (!existsSync(file)) return { data: null }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (err) {
    rmSync(file)
    return { data: null, reason: `Invalid JSON: ${(err as Error).message}` }
  }
  rmSync(file)
  const result = validate(raw)
  return result.ok ? { data: result.value } : { data: null, reason: result.reason }
}

// ────────────────────────────────────────────────────────────────────────────
// Validators
// ────────────────────────────────────────────────────────────────────────────

const HANDOFF_VERDICTS = ['READY_FOR_REVIEW', 'NEEDS_FIXES', 'BLOCKED'] as const
const REVIEW_VERDICTS = ['READY', 'BLOCKED'] as const
const REVIEW_SEVERITIES = ['high', 'medium', 'low'] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  for (const item of value) {
    if (typeof item !== 'string') return null
  }
  return value as string[]
}

function validateHandoff(
  raw: unknown,
  expectedTaskId: string,
): { ok: true, value: Handoff } | { ok: false, reason: string } {
  if (!isObject(raw)) return { ok: false, reason: 'handoff must be a JSON object' }
  if (raw.task_id !== expectedTaskId) {
    return { ok: false, reason: `task_id mismatch: expected ${expectedTaskId}, got ${String(raw.task_id)}` }
  }
  const verdict = raw.verdict
  if (typeof verdict !== 'string' || !HANDOFF_VERDICTS.includes(verdict as typeof HANDOFF_VERDICTS[number])) {
    return { ok: false, reason: `invalid verdict: ${String(verdict)}; expected one of ${HANDOFF_VERDICTS.join(', ')}` }
  }
  if (typeof raw.scope_ok !== 'boolean') {
    return { ok: false, reason: 'scope_ok must be a boolean' }
  }
  if (typeof raw.notes !== 'string') {
    return { ok: false, reason: 'notes must be a string' }
  }
  for (const arrayField of ['files_modified', 'files_created', 'files_deleted', 'missed_requirements', 'risky_changes', 'out_of_scope_observations', 'pushbacks'] as const) {
    if (asStringArray(raw[arrayField]) === null) {
      return { ok: false, reason: `${arrayField} must be a string[]` }
    }
  }
  return {
    ok: true,
    value: {
      task_id: raw.task_id as string,
      mode: typeof raw.mode === 'string' ? raw.mode : '',
      verdict: verdict as Handoff['verdict'],
      scope_ok: raw.scope_ok,
      files_modified: raw.files_modified as string[],
      files_created: raw.files_created as string[],
      files_deleted: raw.files_deleted as string[],
      missed_requirements: raw.missed_requirements as string[],
      risky_changes: raw.risky_changes as string[],
      out_of_scope_observations: raw.out_of_scope_observations as string[],
      pushbacks: raw.pushbacks as string[],
      notes: raw.notes,
      summary_of_changes: typeof raw.summary_of_changes === 'string' ? raw.summary_of_changes : undefined,
    },
  }
}

function validateReview(
  raw: unknown,
  expectedTaskId: string,
): { ok: true, value: Review } | { ok: false, reason: string } {
  if (!isObject(raw)) return { ok: false, reason: 'review must be a JSON object' }
  if (raw.task_id !== expectedTaskId) {
    return { ok: false, reason: `task_id mismatch: expected ${expectedTaskId}, got ${String(raw.task_id)}` }
  }
  const verdict = raw.verdict
  if (typeof verdict !== 'string' || !REVIEW_VERDICTS.includes(verdict as typeof REVIEW_VERDICTS[number])) {
    return { ok: false, reason: `invalid verdict: ${String(verdict)}; expected READY or BLOCKED` }
  }
  if (typeof raw.notes !== 'string') {
    return { ok: false, reason: 'notes must be a string' }
  }
  if (asStringArray(raw.files_reviewed) === null) {
    return { ok: false, reason: 'files_reviewed must be a string[]' }
  }
  if (!Array.isArray(raw.issues)) {
    return { ok: false, reason: 'issues must be an array' }
  }
  const issues: ReviewIssue[] = []
  for (let i = 0; i < raw.issues.length; i++) {
    const issue = raw.issues[i]
    if (!isObject(issue)) {
      return { ok: false, reason: `issues[${i}] must be an object` }
    }
    if (typeof issue.severity !== 'string' || !REVIEW_SEVERITIES.includes(issue.severity as typeof REVIEW_SEVERITIES[number])) {
      return { ok: false, reason: `issues[${i}].severity must be high, medium, or low` }
    }
    if (typeof issue.description !== 'string') {
      return { ok: false, reason: `issues[${i}].description must be a string` }
    }
    issues.push({
      axis: typeof issue.axis === 'string' ? issue.axis : 'spec',
      severity: issue.severity as ReviewIssue['severity'],
      file: typeof issue.file === 'string' ? issue.file : '',
      line: typeof issue.line === 'number' ? issue.line : null,
      description: issue.description,
    })
  }
  return {
    ok: true,
    value: {
      task_id: raw.task_id as string,
      verdict: verdict as Review['verdict'],
      checked_at: typeof raw.checked_at === 'string' ? raw.checked_at : new Date().toISOString(),
      files_reviewed: raw.files_reviewed as string[],
      issues,
      notes: raw.notes,
    },
  }
}
