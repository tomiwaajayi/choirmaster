/**
 * Prompt builders. The system prompt comes from a markdown file the user
 * authors (typically `.choirmaster/prompts/implementer.md`); the runtime
 * loads the file, strips any YAML frontmatter, and prepends the project's
 * `strictInstructions` so universal rules don't have to be restated in
 * every prompt.
 *
 * The user prompt is built per turn from the task contract.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ProjectConfig, Task } from '../types.js'

export type ImplementerMode =
  | 'INITIAL_IMPLEMENTATION'
  | 'FIX_CHECK_FAILURES'
  | 'FIX_REVIEW_FINDINGS'

/** Read a prompt file and strip a leading YAML frontmatter block, if any. */
export function loadPromptFile(projectRoot: string, relativePath: string): string {
  const raw = readFileSync(join(projectRoot, relativePath), 'utf8')
  return raw.replace(/^---[\s\S]*?---\s*/m, '').trim()
}

/**
 * Compose the final system prompt for an agent turn. Layers in:
 *   1. The user's role-specific prompt file (loaded from disk).
 *   2. The project's strictInstructions, if any.
 *
 * Strict instructions are project-wide invariants and always rendered
 * after the role prompt so they're the last things the agent reads
 * before the task brief.
 */
export function buildSystemPrompt(rolePrompt: string, config: ProjectConfig): string {
  const strict = config.strictInstructions ?? []
  if (strict.length === 0) return rolePrompt
  const numbered = strict.map((rule, i) => `${i + 1}. ${rule}`).join('\n')
  return [
    rolePrompt,
    '',
    '---',
    '',
    '# Project-wide rules (must be obeyed regardless of task)',
    '',
    numbered,
  ].join('\n')
}

/** Build the per-turn user prompt for the implementer. */
export function buildImplementerUserPrompt(
  task: Task,
  mode: ImplementerMode,
  extra: string,
  config: ProjectConfig,
): string {
  const allForbidden = [
    ...(config.forbiddenPaths ?? []),
    ...task.forbidden_paths,
  ]
  const lines: string[] = [
    `# Task brief`,
    '',
    `Task: ${task.id} - ${task.title}`,
    task.description ? `Description: ${task.description}` : '',
    task.spec_section ? `Spec section: ${task.spec_section}` : '',
    '',
    `Mode: ${mode}`,
    '',
    `Base ref: ${task.base_ref ?? '(unknown)'} @ ${task.base_sha ?? '(unknown)'}`,
    '',
    'Allowed paths (you may edit only these):',
    ...task.allowed_paths.map((p) => `  - ${p}`),
    '',
    'Forbidden paths (you must not edit any of these, even if they match an allowed glob):',
    ...allForbidden.map((p) => `  - ${p}`),
    '',
    'Definition of done:',
    ...task.definition_of_done.map((d, i) => `  ${i + 1}. ${d}`),
  ]
  if (task.depends_on && task.depends_on.length > 0) {
    lines.push('')
    lines.push(`Depends on: ${task.depends_on.join(', ')}`)
  }
  if (extra.trim()) {
    lines.push('', '---', '', extra.trim())
  }
  return lines.filter((l) => l !== undefined).join('\n')
}

/** Build the per-turn user prompt for the reviewer. */
export function buildReviewerUserPrompt(
  task: Task,
  implementerSummary: string,
  config: ProjectConfig,
): string {
  const allForbidden = [
    ...(config.forbiddenPaths ?? []),
    ...task.forbidden_paths,
  ]
  const lines: string[] = [
    `# Review brief`,
    '',
    `Task: ${task.id} - ${task.title}`,
    task.spec_section ? `Spec section: ${task.spec_section}` : '',
    '',
    `Implementer's summary of changes:`,
    implementerSummary || '(none provided)',
    '',
    'To see the full diff (the implementer typically leaves edits uncommitted, so',
    '`git diff <base>...HEAD` alone may show nothing):',
    `  git diff ${task.base_sha ?? task.base_ref ?? 'HEAD'}    # all tracked changes since base`,
    `  git status -s                              # also see untracked files`,
    '',
    'Allowed paths (anything outside is a scope violation):',
    ...task.allowed_paths.map((p) => `  - ${p}`),
    '',
    'Forbidden paths:',
    ...allForbidden.map((p) => `  - ${p}`),
    '',
    'Definition of done (every item must hold for READY):',
    ...task.definition_of_done.map((d, i) => `  ${i + 1}. ${d}`),
  ]
  return lines.filter((l) => l !== undefined).join('\n')
}
