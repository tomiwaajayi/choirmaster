/**
 * `choirmaster init`
 *
 * Scaffolds `.choirmaster/` in the current repo: typed manifest, prompt files
 * for implementer + reviewer, an example plan, and a `.gitignore` entry for
 * the per-run state directory. Refuses to overwrite an existing
 * `.choirmaster/` unless `--force` is passed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

  writeFileSync(join(choirDir, 'manifest.ts'), MANIFEST_TEMPLATE)
  writeFileSync(join(choirDir, 'prompts', 'implementer.md'), IMPLEMENTER_TEMPLATE)
  writeFileSync(join(choirDir, 'prompts', 'reviewer.md'), REVIEWER_TEMPLATE)
  writeFileSync(join(choirDir, 'plans', 'example.md'), EXAMPLE_PLAN_TEMPLATE)
  writeFileSync(join(choirDir, 'plans', 'example.tasks.json'), EXAMPLE_TASKS_TEMPLATE)

  ensureGitignoreEntry(cwd)

  process.stdout.write(`\nChoirMaster scaffolded in .choirmaster/\n\n`)
  process.stdout.write(`Files created:\n`)
  process.stdout.write(`  .choirmaster/manifest.ts\n`)
  process.stdout.write(`  .choirmaster/prompts/implementer.md\n`)
  process.stdout.write(`  .choirmaster/prompts/reviewer.md\n`)
  process.stdout.write(`  .choirmaster/plans/example.md\n`)
  process.stdout.write(`  .choirmaster/plans/example.tasks.json\n`)
  process.stdout.write(`\nNext steps:\n`)
  process.stdout.write(`  1. Install the runtime packages in this project:\n`)
  process.stdout.write(`     npm install --save-dev @choirmaster/core @choirmaster/agent-claude\n`)
  process.stdout.write(`  2. Make sure the 'claude' CLI is installed and authenticated:\n`)
  process.stdout.write(`     claude --version\n`)
  process.stdout.write(`  3. Edit .choirmaster/manifest.ts:\n`)
  process.stdout.write(`     - Set 'base' to your default branch (main, staging, etc.)\n`)
  process.stdout.write(`     - Add gates (typecheck/test commands) if you want them enforced per task\n`)
  process.stdout.write(`     - Tune strictInstructions and forbiddenPaths for your project\n`)
  process.stdout.write(`  4. Try the example task end-to-end:\n`)
  process.stdout.write(`     choirmaster run .choirmaster/plans/example.tasks.json\n`)
  process.stdout.write(`\n`)
  return 0
}

function ensureGitignoreEntry(cwd: string): void {
  const path = join(cwd, '.gitignore')
  const entry = `\n# ChoirMaster per-run state and logs (do not commit)\n.choirmaster/runs/\n`
  if (!existsSync(path)) {
    writeFileSync(path, entry.trimStart())
    return
  }
  const current = readFileSync(path, 'utf8')
  if (current.includes('.choirmaster/runs')) return
  appendFileSync(path, entry)
}

// ────────────────────────────────────────────────────────────────────────────
// Templates
// ────────────────────────────────────────────────────────────────────────────

const MANIFEST_TEMPLATE = `import { defineProject, perTaskMerge, worktreeSandbox } from '@choirmaster/core'
import { claude } from '@choirmaster/agent-claude'

export default defineProject({
  // The branch tasks will fork from and (with perTaskMerge) merge back into.
  base: 'main',

  // Claude is the default for every role. Mix models per role, or swap in
  // a different engine entirely (e.g. @choirmaster/agent-codex once shipped).
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

const EXAMPLE_PLAN_TEMPLATE = `# Example plan

> Edit this to describe what you want done. The planner agent (when shipped) will turn plan files like this into a tasks.json contract list. For now, you author the tasks.json directly - see \`example.tasks.json\` next to this file.

## Goal

A short one-line statement of what this plan accomplishes.

## Tasks

For each task, declare:
- A title
- The files in scope (allowed_paths)
- Anything to avoid (forbidden_paths)
- The deterministic gates that should pass after the task
- The definition of done

## Constraints

- Don't touch X
- Must use Y
- Preserve Z

## Retry caps

Each task has a budget for implementer attempts (\`max_attempts\`) and reviewer iterations (\`max_review_iterations\`). Per-task fields are optional - omit them to inherit the manifest's \`limits\`, which itself falls back to the built-in defaults (4 attempts, 3 reviewer iterations). Set per-task only when one task warrants a different cap.
`

const EXAMPLE_TASKS_TEMPLATE = `[
  {
    "id": "TASK-01",
    "title": "Add a hello world note",
    "description": "Create a NOTES.md file at the repo root with a single greeting line. A trivial task you can use to verify the orchestrator pipeline works end-to-end.",
    "branch": "choirmaster/task-01-hello",
    "worktree": ".choirmaster/runs/active/worktrees/task-01",
    "allowed_paths": ["NOTES.md"],
    "forbidden_paths": [],
    "gates": [],
    "definition_of_done": [
      "NOTES.md exists at the repo root",
      "It contains a one-line greeting"
    ],
    "attempts": 0,
    "review_iterations": 0,
    "status": "pending"
  }
]
`
