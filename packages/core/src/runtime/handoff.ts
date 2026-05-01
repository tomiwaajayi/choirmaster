/**
 * Read the structured JSON files agents write to communicate verdicts.
 * The implementer writes `<worktree>/.choirmaster/handoff.json` after each
 * turn; the reviewer writes `<worktree>/.choirmaster/review.json`.
 *
 * Files are removed after reading so a stale artifact from a previous turn
 * never confuses the next one.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import type { Handoff, Review } from '../types.js'

export const HANDOFF_RELATIVE_PATH = '.choirmaster/handoff.json'
export const REVIEW_RELATIVE_PATH = '.choirmaster/review.json'

export function readHandoff(worktreeCwd: string): Handoff | null {
  return readJsonOnce<Handoff>(join(worktreeCwd, HANDOFF_RELATIVE_PATH))
}

export function readReview(worktreeCwd: string): Review | null {
  return readJsonOnce<Review>(join(worktreeCwd, REVIEW_RELATIVE_PATH))
}

function readJsonOnce<T>(file: string): T | null {
  if (!existsSync(file)) return null
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as T
    rmSync(file)
    return parsed
  }
  catch {
    return null
  }
}
