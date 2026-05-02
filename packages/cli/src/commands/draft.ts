/**
 * `choirmaster draft [goal] [--from notes.md] [--output plan.md]`
 *
 * Deterministic, no-token plan authoring helper. It creates a strong markdown
 * plan scaffold that the user can edit before handing it to `choirmaster run`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, resolve } from 'node:path'

import { resolveProjectRoot } from '../project-root.js'

export interface DraftCommandArgs {
  /** Rough engineering goal, for example "add rate limiting to auth". */
  goal?: string
  /** Optional source notes file to fold into the draft. */
  fromFile?: string
  /** Optional output markdown path. */
  outputFile?: string
  /** Allow overwriting an existing markdown plan. */
  force?: boolean
  /** Working directory; defaults to process.cwd(). */
  cwd?: string
}

export async function draftCommand(args: DraftCommandArgs = {}): Promise<number> {
  const projectRoot = resolveProjectRoot(args.cwd ?? process.cwd())
  const goal = normalizeGoal(args.goal)
  let source: { label: string; content: string } | undefined

  if (args.fromFile) {
    const sourcePath = resolve(projectRoot, args.fromFile)
    if (!existsSync(sourcePath)) {
      process.stderr.write(`source file not found: ${sourcePath}\n`)
      return 1
    }
    if (!statSync(sourcePath).isFile()) {
      process.stderr.write(`source path is not a file: ${sourcePath}\n`)
      return 64
    }
    source = {
      label: shortPath(sourcePath, projectRoot),
      content: readFileSync(sourcePath, 'utf8'),
    }
  }

  const title = chooseTitle(goal, source)
  const outputPath = args.outputFile
    ? resolve(projectRoot, args.outputFile)
    : resolve(projectRoot, '.choirmaster/plans', `${slugify(title)}.md`)

  if (extname(outputPath).toLowerCase() !== '.md') {
    process.stderr.write(`draft output must be a markdown (.md) file: ${shortPath(outputPath, projectRoot)}\n`)
    return 64
  }
  if (existsSync(outputPath) && !args.force) {
    process.stderr.write(
      `draft already exists: ${shortPath(outputPath, projectRoot)}. Pass --force to overwrite.\n`,
    )
    return 1
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, buildDraftPlan({ title, goal, source }))

  const relOutput = shortPath(outputPath, projectRoot)
  process.stdout.write(`\nDraft plan created: ${relOutput}\n`)
  if (!goal && !source) {
    process.stdout.write(`Tip: pass a goal for a more useful draft, for example: choirmaster draft "add rate limiting to login"\n`)
  }
  if (!isInsideProject(outputPath, projectRoot)) {
    process.stdout.write(`Warning: draft was written outside the project root; @ shortcuts only match markdown files inside the repo.\n`)
  }
  process.stdout.write(`Edit it, then run: choirmaster run ${relOutput}\n`)
  if (isInsideProject(outputPath, projectRoot)) {
    process.stdout.write(`Shortcut after shell completions: cm run @${slugify(title)}\n`)
  }
  process.stdout.write(`\n`)
  return 0
}

function buildDraftPlan({
  title,
  goal,
  source,
}: {
  title: string
  goal: string
  source?: { label: string; content: string }
}): string {
  const goalText = goal || 'TODO: Describe the engineering outcome in one or two concrete sentences.'
  const sourceFence = source ? fenceForContent(source.content) : '````'
  const sourceSection = source
    ? `
## Source Notes

Imported from \`${source.label}\`. Keep the useful parts, delete anything that no longer applies, and make assumptions explicit before running.

${sourceFence}md
${trimSource(source.content)}
${sourceFence}
`
    : ''

  return `# ${title}

This is the human plan for ChoirMaster. Tighten it before running; the planner will turn this markdown into scoped executable tasks.

> Draft note: before running, answer or delete the clarifying questions below. If you leave a recommended default in place, ChoirMaster will treat it as an accepted assumption.

## Goal

${goalText}

## Clarifying Questions

Use these prompts to remove ambiguity. Delete questions that are already answered. Keep assumptions explicit if you choose the recommended default.

### Scope

- Question: Which packages, directories, routes, screens, or workflows are in scope?
  Recommended default: start with the smallest useful slice and leave the rest out of scope.
- Question: Are there files or areas that must not change?
  Recommended default: preserve public APIs, generated files, secrets, lockfiles, and unrelated styling.

### Rollout

- Question: Should this land as one small change, phased dependent tasks, or a migration plan?
  Recommended default: use phased tasks when the work touches multiple layers or many files.
- Question: Does old and new behavior need to coexist temporarily?
  Recommended default: coexist first for migrations; remove old paths only after parity is verified.

### Verification

- Question: What commands, tests, screenshots, or manual checks prove this worked?
  Recommended default: include existing typecheck/test/build commands plus one targeted check for the changed behavior.
- Question: What would count as a blocker rather than a follow-up?
  Recommended default: any broken gate, scope leak, data-loss risk, or missed definition of done item blocks.

## Constraints

- Keep changes scoped to the goal above.
- Prefer small reviewable tasks over one broad task.
- Do not edit secrets, credentials, generated build outputs, or unrelated files.
- Preserve existing behavior unless the goal explicitly asks to change it.

## Definition of Done

- The requested behavior or artifact exists.
- The change is covered by the relevant deterministic checks.
- No out-of-scope files are changed.
- Any assumptions are documented in the task handoff.

## Out Of Scope

- Broad cleanup not needed for this goal.
- Unrelated refactors.
- Package upgrades unless they are required for the goal.

## Notes for the Planner

- Split into dependent tasks only when that makes review safer.
- Keep each task's \`allowed_paths\` narrow.
- Include explicit \`depends_on\` links when later tasks rely on earlier ones.
- Prefer task branches and worktrees under \`.choirmaster/runs/active/worktrees/\`.
${sourceSection}`
}

function chooseTitle(goal: string, source?: { label: string; content: string }): string {
  if (goal) return `Plan: ${titleCase(goal)}`
  const heading = source ? firstMarkdownHeading(source.content) : ''
  if (heading) return `Plan: ${heading}`
  if (source) return `Plan: ${titleCase(basename(source.label, extname(source.label)).replace(/[-_]+/g, ' '))}`
  return 'Plan: Draft Engineering Change'
}

function firstMarkdownHeading(content: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return normalizeGoal(match?.[1] ?? '')
}

function normalizeGoal(goal: string | undefined): string {
  return (goal ?? '').replace(/\s+/g, ' ').trim()
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/^plan:\s*/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug || 'draft-plan'
}

function trimSource(content: string): string {
  const maxChars = 12_000
  if (content.length <= maxChars) return content.trim()
  return `${content.slice(0, maxChars).trim()}\n\n[Truncated: source notes were longer than ${maxChars} characters.]`
}

function fenceForContent(content: string): string {
  const runs = content.match(/`+/g) ?? []
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0)
  return '`'.repeat(Math.max(4, longest + 1))
}

function shortPath(absPath: string, projectRoot: string): string {
  const relPrefix = `${projectRoot}/`
  return absPath.startsWith(relPrefix) ? absPath.slice(relPrefix.length) : absPath
}

function isInsideProject(absPath: string, projectRoot: string): boolean {
  return absPath === projectRoot || absPath.startsWith(`${projectRoot}/`)
}
