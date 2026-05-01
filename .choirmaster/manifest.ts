import { claude, defineProject, headOnly, worktreeSandbox } from 'choirmaster'

export default defineProject({
  base: 'main',

  agents: {
    planner: claude('opus'),
    implementer: claude('sonnet'),
    reviewer: claude('opus'),
  },

  // Real gates so any task we run on this repo is verified the same way
  // CI would verify it. Type-check first (cheap), then tests, then build.
  gates: [
    { name: 'typecheck', command: 'pnpm typecheck' },
    { name: 'test',      command: 'pnpm test' },
    { name: 'build',     command: 'pnpm build' },
  ],

  // ff-only merge per task. Dogfood tasks here are small and frequent;
  // the merge commits perTaskMerge() produces are noise we'd rather
  // skip. perTaskMerge() is still the default for new projects via
  // `choirmaster init`.
  branchPolicy: headOnly(),
  sandbox: worktreeSandbox({
    // Each fresh worktree is missing node_modules (gitignored). Install
    // deps once after creation so gates have tsc / vitest / tsup on PATH.
    prepare: {
      command: 'pnpm install --frozen-lockfile',
      run: 'once-per-worktree',
    },
  }),

  prompts: {
    planner:      '.choirmaster/prompts/planner.md',
    planReviewer: '.choirmaster/prompts/plan-reviewer.md',
    implementer:  '.choirmaster/prompts/implementer.md',
    reviewer:     '.choirmaster/prompts/reviewer.md',
  },

  forbiddenPaths: [
    '.env',
    '.env.*',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    '.git/**',
    '.github/**',
    // Build outputs for the workspace packages. The runtime and CI
    // rebuild these; agents must never commit them by hand.
    'packages/*/dist/**',
    'packages/*/*.tsbuildinfo',
  ],

  strictInstructions: [
    'Never run package manager install commands (npm install, pnpm install, yarn install).',
    'Never commit secrets, API keys, or credentials.',
    'Never modify lockfiles directly; let the build do it.',
    'Never use the em dash character (U+2014); use a hyphen instead.',
    'Never edit files in `packages/*/dist/`; those are build outputs.',
  ],
})
