/**
 * Detect Claude Max capacity / rate-limit errors. Gates on non-zero exit
 * AND stderr-only matching - assistant content in stdout (which mirrors
 * the codebase Claude is reading) regularly contains phrases like "rate
 * limit" or "429" that would falsely trigger a content-based matcher.
 *
 * The pattern set is generous because Anthropic has shifted error wording
 * across CLI versions. False negatives (a real cap that escapes detection)
 * degrade to "task ends blocked with non-zero exit", which is recoverable;
 * false positives consumed real Claude turns and corrupted run state, so
 * we err strongly on the side of false negatives.
 */

const USAGE_LIMIT_PATTERNS: RegExp[] = [
  /usage limit/i,
  /rate limit/i,
  /reached.*limit/i,
  /quota.*exceed/i,
  /try again in \d/i,
  /too many requests/i,
  /5[-\s]?hour.*limit/i,
  /weekly.*limit/i,
  /upgrade.*plan/i,
  /\b429\b/,
]

export interface CapacityCheckInput {
  exitStatus: number | null
  stderr: string
}

export interface CapacityCheckResult {
  hit: boolean
  signal?: string
}

export function detectCapacityError(input: CapacityCheckInput): CapacityCheckResult {
  if (input.exitStatus === 0) return { hit: false }
  for (const pattern of USAGE_LIMIT_PATTERNS) {
    const match = input.stderr.match(pattern)
    if (match) return { hit: true, signal: match[0] }
  }
  return { hit: false }
}
