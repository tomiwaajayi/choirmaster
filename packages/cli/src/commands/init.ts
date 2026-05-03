/**
 * `choirmaster init`
 *
 * Scaffolds `.choirmaster/` in the current repo: typed manifest, prompt
 * files for planner, plan reviewer, implementer, and reviewer, an example
 * markdown plan, and `.gitignore` entries for generated runtime artifacts.
 * Refuses to overwrite an existing `.choirmaster/`
 * unless `--force` is passed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { currentBranch } from '@choirmaster/core'

export interface InitCommandArgs {
  cwd?: string
  force?: boolean
}

export async function initCommand(args: InitCommandArgs = {}): Promise<number> {
  const cwd = args.cwd ?? process.cwd()
  const choirDir = join(cwd, '.choirmaster')

  if (existsSync(choirDir) && !args.force) {
    process.stderr.write(
      `.choirmaster/ already exists in ${cwd}. Pass --force to overwrite.\n`,
    )
    return 1
  }

  mkdirSync(choirDir, { recursive: true })
  mkdirSync(join(choirDir, 'prompts'), { recursive: true })
  mkdirSync(join(choirDir, 'plans'), { recursive: true })
  mkdirSync(join(choirDir, 'tasks'), { recursive: true })

  const baseBranch = currentBranch(cwd) ?? 'main'

  writeFileSync(join(choirDir, 'manifest.ts'), manifestTemplate(baseBranch))
  writeFileSync(join(choirDir, 'prompts', 'planner.md'), PLANNER_TEMPLATE)
  writeFileSync(join(choirDir, 'prompts', 'plan-reviewer.md'), PLAN_REVIEWER_TEMPLATE)
  writeFileSync(join(choirDir, 'prompts', 'implementer.md'), IMPLEMENTER_TEMPLATE)
  writeFileSync(join(choirDir, 'prompts', 'reviewer.md'), REVIEWER_TEMPLATE)
  writeFileSync(join(choirDir, 'plans', 'example.md'), EXAMPLE_PLAN_TEMPLATE)

  ensureGitignoreEntry(cwd)

  process.stdout.write(`\nChoirMaster scaffolded in .choirmaster/\n\n`)
  process.stdout.write(`Files created:\n`)
  process.stdout.write(`  .choirmaster/manifest.ts\n`)
  process.stdout.write(`  .choirmaster/prompts/planner.md\n`)
  process.stdout.write(`  .choirmaster/prompts/plan-reviewer.md\n`)
  process.stdout.write(`  .choirmaster/prompts/implementer.md\n`)
  process.stdout.write(`  .choirmaster/prompts/reviewer.md\n`)
  process.stdout.write(`  .choirmaster/plans/example.md\n`)
  process.stdout.write(`\nNext steps:\n`)
  process.stdout.write(`  1. Add choirmaster as a project dev dependency so manifest.ts resolves locally.\n`)
  process.stdout.write(`     Do this even if you also installed the CLI globally:\n`)
  process.stdout.write(`     npm install --save-dev choirmaster\n`)
  process.stdout.write(`  2. Make sure the 'claude' CLI is installed and authenticated:\n`)
  process.stdout.write(`     claude --version\n`)
  process.stdout.write(`  3. Edit .choirmaster/manifest.ts:\n`)
  process.stdout.write(`     - 'base' was initialized to '${baseBranch}' from the current branch\n`)
  process.stdout.write(`     - Change 'base' if you want tasks to fork from and merge into another branch\n`)
  process.stdout.write(`     - Add gates (typecheck/test commands) if you want them enforced per task\n`)
  process.stdout.write(`     - Tune strictInstructions and forbiddenPaths for your project\n`)
  process.stdout.write(`  4. Check your setup:\n`)
  process.stdout.write(`       choirmaster doctor\n`)
  process.stdout.write(`  5. Draft your own markdown plan, or try the example end-to-end. Either:\n`)
  process.stdout.write(`       choirmaster draft --interactive "describe the change you want"\n`)
  process.stdout.write(`       choirmaster draft "describe the change you want"        # quick editable scaffold\n`)
  process.stdout.write(`       choirmaster run                                       # open the built-in markdown picker\n`)
  process.stdout.write(`       choirmaster run @example                              # exact reference to the example markdown plan\n`)
  process.stdout.write(`       choirmaster run .choirmaster/plans/example.md          # same thing, explicit path\n`)
  process.stdout.write(`       choirmaster plan @example                             # inspect the generated task contract\n`)
  process.stdout.write(`  6. (Optional) install live shell completions for @-references:\n`)
  process.stdout.write(`       choirmaster completions <zsh|bash|fish|powershell|nushell>\n`)
  process.stdout.write(`\n`)
  return 0
}

function ensureGitignoreEntry(cwd: string): void {
  const path = join(cwd, '.gitignore')
  if (!existsSync(path)) {
    writeFileSync(path, GITIGNORE_ENTRY.trimStart())
    return
  }
  const current = readFileSync(path, 'utf8')
  const cleaned = removeObsoleteIgnoreRules(current)
  const eol = detectLineEnding(cleaned || current)
  if (cleaned !== current) writeFileSync(path, cleaned)
  const missingLines = GITIGNORE_LINES.filter((line) => !hasEquivalentIgnoreRule(cleaned, line))
  if (missingLines.length === 0) return
  const prefix = !cleaned || cleaned.endsWith(eol) ? '' : eol
  const hasHeader = cleaned.includes('# ChoirMaster generated artifacts') || cleaned.includes('# ChoirMaster per-run state')
  const header = hasHeader ? '' : `# ChoirMaster generated artifacts (do not commit)${eol}`
  appendFileSync(path, `${prefix}${header}${missingLines.join(eol)}${eol}`)
}

const GITIGNORE_LINES = [
  '.choirmaster/runs/',
  '.choirmaster/tasks/',
]

const GITIGNORE_ENTRY = `# ChoirMaster generated artifacts (do not commit)
${GITIGNORE_LINES.join('\n')}
`

function removeObsoleteIgnoreRules(content: string): string {
  const eol = detectLineEnding(content)
  const withoutObsolete = content
    .split(/\r\n|\n/)
    .filter((line) => line.trim() !== '.choirmaster/plans/*.tasks.json')
    .join(eol)
  return collapseBlankLines(withoutObsolete, eol)
}

function detectLineEnding(content: string): string {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

function collapseBlankLines(content: string, eol: string): string {
  const lines = content.split(/\r\n|\n/)
  const kept: string[] = []
  let blankRun = 0
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun += 1
      if (blankRun > 1) continue
    }
    else {
      blankRun = 0
    }
    kept.push(line)
  }
  return kept.join(eol)
}

function hasEquivalentIgnoreRule(content: string, required: string): boolean {
  const rules = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  if (rules.includes(required)) return true
  if (required === '.choirmaster/runs/') {
    return rules.some((rule) => rule === '.choirmaster/' || rule === '.choirmaster/runs/**')
  }
  if (required === '.choirmaster/tasks/') {
    return rules.some((rule) =>
      rule === '.choirmaster/'
      || rule === '.choirmaster/tasks/**'
    )
  }
  return false
}

// ────────────────────────────────────────────────────────────────────────────
// Templates
// ────────────────────────────────────────────────────────────────────────────

function manifestTemplate(baseBranch: string): string {
  return `import { claude, defineProject, perTaskMerge, worktreeSandbox } from 'choirmaster'

export default defineProject({
  // The branch tasks will fork from and (with perTaskMerge) merge back into.
  base: ${JSON.stringify(baseBranch)},

  // Claude is the default for every role. Mix models per role; future
  // releases will export additional agent factories alongside \`claude\`.
  agents: {
    planner: claude('opus'),
    implementer: claude('sonnet'),
    reviewer: claude('opus'),
  },

  // Deterministic gates run after every implementer turn. Failures route
  // back to the implementer with the failure output; the reviewer never
  // sees broken code. Add the gates that matter for your project:
  gates: [
    // { name: 'typecheck', command: 'npm run typecheck' },
    // { name: 'test',      command: 'npm test' },
  ],

  // How completed task branches rejoin the base.
  //   perTaskMerge():    --no-ff merge per task (default; preserves history)
  //   headOnly():        --ff-only merge (no merge commit)
  //   perTaskBranch():   leaves each task on its branch; merge manually
  branchPolicy: perTaskMerge(),

  // Default sandbox: a git worktree on the host. Cheap, fast, no container.
  sandbox: worktreeSandbox(),

  // Where prompt files live. Edit these to match your team's voice.
  prompts: {
    planner:      '.choirmaster/prompts/planner.md',
    planReviewer: '.choirmaster/prompts/plan-reviewer.md',
    implementer:  '.choirmaster/prompts/implementer.md',
    reviewer:     '.choirmaster/prompts/reviewer.md',
  },

  // Globs hard-blocked across every task, regardless of allowed_paths.
  forbiddenPaths: [
    '.env',
    '.env.*',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '.git/**',
    '.github/**',
  ],

  // Rules prepended to every implementer + reviewer prompt. Use for
  // project-wide invariants the per-task DoD shouldn't have to restate.
  strictInstructions: [
    'Never run package manager install commands (npm install, pnpm install, yarn install).',
    'Never commit secrets, API keys, or credentials.',
    'Never modify lockfiles directly; let the build do it.',
  ],

  // Retry caps and timeouts applied to every task that doesn't override
  // them in its own contract. Defaults: maxAttempts=4, maxReviewIterations=3.
  // limits: {
  //   maxAttempts: 4,            // implementer attempts before giving up
  //   maxReviewIterations: 3,    // reviewer rounds before final-verify
  //   agentTurnTimeoutMs: 30 * 60 * 1000,  // per-call timeout (default 30 min)
  // },
})
`
}

const PLANNER_TEMPLATE = `# Planner agent

You are the planner in a ChoirMaster orchestration loop. You receive a markdown plan describing what the user wants done and produce a JSON list of tasks the runtime can execute.

## Hard rules (never break these)

1. **One output, one path.** The runtime prompt will give you the exact planner-output JSON path under \`.choirmaster/tasks/.tmp/\`. Write only to that path. Never edit any other file.
2. **Output shape.** A JSON array of task objects. No wrapping object, no markdown fences, no commentary - just the array.
3. **Stay inside the project root.** Worktree paths must be relative, must not contain \`..\` segments, and must not be absolute.
4. **Unique ids, branches, worktrees.** Across the array, every task's \`id\`, \`branch\`, and \`worktree\` must be distinct.
5. **No self-references in \`depends_on\`.** A task cannot depend on itself; cycles will be rejected.
6. **Draft scaffolds are not requirements.** If the plan contains \`Question:\` lines from \`choirmaster draft\`, use them only to identify assumptions. Do not turn unanswered question text into implementation work.

## Workflow

1. Read the plan markdown carefully.
2. If draft questions remain, prefer narrow tasks and include any assumptions in task descriptions. Do not guess broad scope from unanswered questions.
3. Explore the codebase as needed to understand what each task would touch (Read, Glob, Grep).
4. Decompose the plan into small, independently completable tasks. Prefer many small tasks over few sprawling ones.
5. Each task must:
   - declare \`allowed_paths\` precisely - the actual files that need editing, not catch-all globs
   - have a \`definition_of_done\` whose every item a reviewer can verify against the diff
   - belong to a single, narrow concern (refactor, add, rename, fix)
6. Use \`depends_on\` to express ordering. Don't rely on array order.
7. Write the exact planner-output JSON file named in the runtime prompt and stop.

## Task schema

Each task is a JSON object:

\`\`\`json
{
  "id": "TASK-01",
  "title": "Short imperative title",
  "description": "Optional one-paragraph context for the implementer",
  "branch": "choirmaster/task-01-short-slug",
  "worktree": ".choirmaster/runs/active/worktrees/task-01",
  "allowed_paths": ["app/auth/**"],
  "forbidden_paths": [],
  "gates": [],
  "definition_of_done": [
    "auth/login.ts uses the new session helper",
    "All call sites updated"
  ],
  "depends_on": []
}
\`\`\`

Required: \`id\`, \`title\`, \`branch\`, \`worktree\`, \`allowed_paths\`, \`definition_of_done\`.
Optional: \`description\`, \`forbidden_paths\`, \`gates\`, \`depends_on\`, \`max_attempts\`, \`max_review_iterations\`, \`spec_section\`.

## Conventions (recommended, not enforced)

- Ids: \`TASK-01\`, \`TASK-02\`, ... in execution order ignoring deps.
- Branches: \`choirmaster/task-01-<short-slug>\`.
- Worktrees: \`.choirmaster/runs/active/worktrees/task-01\`.

## What "good" looks like

- Each task fits in one implementer turn (under ~30 minutes of focused work).
- \`allowed_paths\` matches what truly needs to change. If you'd write \`**\`, split the task.
- \`definition_of_done\` items are specific and checkable.
- Two tasks never edit the same file unless one depends on the other.
- Forbidden paths declared in the project manifest are NOT listed inside individual tasks - they apply automatically.
`

const IMPLEMENTER_TEMPLATE = `# Implementer agent

You are the implementer in a ChoirMaster orchestration loop. You receive a single task contract and operate inside a git worktree. Your job is to implement the task and write a structured handoff file.

## Hard rules (never break these)

1. **Stay in scope.** You only edit files matching the task's \`allowed_paths\`. If the spec implies you'd need to edit something outside, write a note in \`out_of_scope_observations\` and stop. The orchestrator will surface it.
2. **Forbidden paths are absolute.** Never edit a file in \`forbidden_paths\`, even if it matches an allowed glob. Forbidden takes precedence.
3. **Never commit, push, branch, merge, or run install commands.** The orchestrator owns all git state-changing operations and dependency management.
4. **Never run typecheck/test/audit commands yourself.** The orchestrator runs deterministic gates after your turn; trust their results.
5. **Always write a handoff file** at \`.choirmaster/handoff.json\` before stopping.

## Workflow

1. Read the task brief carefully. Pay attention to \`definition_of_done\`: each item must hold.
2. Read the relevant source files using Read / Grep / Glob.
3. Make focused edits with Edit / MultiEdit / Write.
4. Self-review your diff before writing the handoff. Are all DoD items addressed? Any scope drift? Anything you punted?
5. Write \`.choirmaster/handoff.json\` and stop.

## Handoff file format

\`\`\`json
{
  "task_id": "TASK-01",
  "mode": "INITIAL_IMPLEMENTATION",
  "verdict": "READY_FOR_REVIEW",
  "scope_ok": true,
  "files_modified": ["app/foo.vue"],
  "files_created": [],
  "files_deleted": [],
  "missed_requirements": [],
  "risky_changes": [],
  "out_of_scope_observations": [],
  "pushbacks": [],
  "notes": "All DoD items addressed.",
  "summary_of_changes": "One-line description of what changed and why."
}
\`\`\`

Verdict values:
- \`READY_FOR_REVIEW\`: implementation complete; the reviewer should look.
- \`NEEDS_FIXES\`: rare; you ran a self-review pass and found something to fix in your own work.
- \`BLOCKED\`: you cannot proceed (spec ambiguous, allowed_paths too narrow). Populate \`notes\` with the reason.

## Modes

The user prompt will tell you which mode you're in:

- \`INITIAL_IMPLEMENTATION\`: first pass at the task.
- \`FIX_CHECK_FAILURES\`: deterministic gates failed on a previous attempt; the failure output is in the brief. Read it, fix the cause, write a new handoff.
- \`FIX_REVIEW_FINDINGS\`: the reviewer flagged issues. Read each issue, fix or pushback, write a new handoff. If you genuinely disagree with a reviewer point (rare), explain in \`pushbacks\` rather than ignoring it.
`

const PLAN_REVIEWER_TEMPLATE = `# Plan reviewer agent (placeholder)

> The plan-reviewer role is not yet wired into the runtime; this file
> exists so the manifest's \`prompts.planReviewer\` path resolves and so
> Phase 2B (plan-review iteration) can land without a follow-up edit.
> Phase 2A's planner is single-shot.

When the plan reviewer ships, this prompt will instruct it to:

1. Read the planner's emitted task list and the source markdown plan.
2. Check task scope, dependencies, definitions of done, and risk.
3. Reject tasks that are too broad, ambiguous, or unsafe to execute.
4. Prefer tightening scope and splitting tasks over rewriting the plan.

Until then you can leave this file untouched.
`

const REVIEWER_TEMPLATE = `# Reviewer agent

You are the reviewer in a ChoirMaster orchestration loop. The implementer has finished their turn, the deterministic gates have passed (typecheck/test/audit), and your job is to give an independent second opinion against the task's definition of done.

## Hard rules

1. **Read-only.** You never edit code, never commit, never push. You read, grep, and report.
2. **Never run gate commands** (\`pnpm test\`, \`pnpm typecheck\`, etc.) - the orchestrator already verified them.
3. **Always write \`.choirmaster/review.json\`** before stopping.
4. **Verdict is binary**: \`READY\` or \`BLOCKED\`. If you have any unfixed concern in scope of the DoD, return \`BLOCKED\`. Strict mode: any issue means BLOCKED.

## Workflow

1. Read the review brief. Pay attention to the implementer's summary and every DoD item.
2. Run the diff command suggested in the brief to see what changed.
3. For each DoD item, verify the diff actually satisfies it. Mechanical items (file count, regex matches) get checked. Judgment items (anatomy, naming, tone) get checked too.
4. Check for scope violations - any file edited outside \`allowed_paths\`?
5. Check for missed implications - bugs the implementer didn't notice, follow-on cleanup needed inside scope.
6. Write the review file.

## Review file format

\`\`\`json
{
  "task_id": "TASK-01",
  "verdict": "BLOCKED",
  "checked_at": "2026-05-01T12:00:00Z",
  "files_reviewed": ["app/foo.vue", "app/bar.vue"],
  "issues": [
    {
      "axis": "spec",
      "severity": "high",
      "file": "app/foo.vue",
      "line": 42,
      "description": "DoD item 3 says X; this code does Y."
    }
  ],
  "notes": "Mostly good; one DoD violation in foo.vue."
}
\`\`\`

Severity levels:
- \`high\`: clear violation; reflects a missed spec rule or scope leak
- \`medium\`: should-fix drift
- \`low\`: minor inconsistency

Strict mode: \`READY\` only when the issues array is empty. If you wrote anything down, the verdict is \`BLOCKED\`.
`

const EXAMPLE_PLAN_TEMPLATE = `# Example plan: add a NOTES.md

A trivial plan you can run end-to-end to verify the orchestrator pipeline
works on this repo. Replace this content with your real plan once you've
seen the flow.

To run this plan:

\`\`\`bash
choirmaster run .choirmaster/plans/example.md
\`\`\`

That command:

1. Invokes the planner agent. It reads this markdown, generates a
   validated \`.choirmaster/tasks/example.tasks.json\`, and stops.
2. Hands the generated tasks file to the runtime, which drives each task
   through implementer -> gates -> reviewer -> commit -> merge in an
   isolated git worktree.

## Goal

Create a \`NOTES.md\` file at the repository root that records this is a
ChoirMaster-managed project.

## Constraints

- Only \`NOTES.md\` should be created or modified.
- Do not touch any other file in the repo.
- The file must be brand new; if it already exists, the plan is satisfied
  by the existing file (no change needed).

## Definition of done

- \`NOTES.md\` exists at the repo root.
- It contains exactly two non-empty lines: a one-line greeting and a
  one-line description of what ChoirMaster does for this repository.

## Notes for the planner

This plan is intentionally tiny. One task is enough. Don't invent
additional cleanup, refactor, or test work that isn't asked for.
`
