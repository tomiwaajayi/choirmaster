# ChoirMaster

> Write a markdown plan, get scoped, gated, reviewable agent work.

ChoirMaster is a local CLI for developers and small teams who want to use AI coding agents on real codebases without losing the day to scope drift, broken gates, mystery edits, or unrecoverable runs.

The happy path is markdown-first: you write a plan, run `choirmaster run <plan.md>`, and ChoirMaster turns it into a validated task contract before executing it. Each task then moves through implementer → deterministic gates (typecheck / test / audit) → reviewer → commit → branch policy, all in isolated git worktrees.

The generated `*.tasks.json` file is still there, readable, and safe to inspect or edit. It is the execution contract, not the thing a new user should have to hand-author on day one.

The agents do the work. ChoirMaster owns the loop, the gates, the worktrees, and the merges.

## Status

Pre-alpha. `choirmaster@0.3.0` is published and dogfooded by this repo. APIs will still change.

## Who it's for

Solo developers, indie hackers, and small teams running scoped docs work, tests, refactors, migrations, and cleanup tasks on their own codebases. You write or review the plan, you review the diffs, you ship. ChoirMaster does the mechanical bits in between, inside the scope you defined.

## What it isn't

- **Not a hosted service or SaaS.** It's a local CLI. Runs on your machine. State lives in your repo and your filesystem.
- **Not a Claude or Codex replacement.** Today it ships with a Claude Code adapter and shells out to the `claude` CLI you already have installed and authenticated. Codex and other providers are planned behind the same adapter interface.
- **Not a "give me a goal, I'll do everything" agent.** You provide the plan, set the scope, and read the diffs. ChoirMaster only executes work that fits inside the contract generated from that plan.
- **Not telemetry-bearing.** No analytics, no phone-home, no accounts. The repo is the entire product.

## What you get out of the box

- **Markdown-first planning.** `choirmaster run <plan.md>` plans and runs in one flow. `choirmaster plan <plan.md>` stops after generating the task contract so you can review it first.
- **Typed task contracts.** Each generated `*.tasks.json` declares branches, worktrees, allowed and forbidden paths, gates, dependencies, retry limits, and definitions of done. The runtime validates the whole file before any task starts.
- **Hard scope enforcement.** Edits outside `allowed_paths` are caught after the agent's turn and the worktree is reverted. The check looks at committed + staged + unstaged + untracked, so an agent that ignores the prompt and commits anyway is still rolled back.
- **Planner mutation guard.** Planning runs against the real repo, so ChoirMaster snapshots git-visible state plus configured forbidden paths before and after the planner turn. Rogue planner edits block the run.
- **Project-wide safeguards.** `forbiddenPaths` and `strictInstructions` declared once in your manifest apply to every task: `.env*` always blocked, "never run pnpm install" always in the prompt.
- **Deterministic gates.** Typecheck, test, audit scripts run after every implementer turn. Failures route back to the implementer with the failure summary; the reviewer never sees broken code.
- **Sandbox prepare hook.** Fresh worktrees can run setup once before any agent turn, e.g. `pnpm install --frozen-lockfile`, so real project gates have dependencies available.
- **Recoverable everywhere.** Hit Claude's rate limit mid-run? The orchestrator pauses cleanly and resumes from the same phase on the next run. Killed the process? `choirmaster run --resume <run-id>` picks up where it left off.
- **Configurable branch policy.** Completed tasks can merge into the base branch, fast-forward the base, or stay on task branches for manual review.
- **Per-task git worktrees.** Tasks never touch your main checkout. Inspect any task's branch independently.
- **One package.** The CLI, runtime, Claude adapter, and public types ship as `choirmaster`.

## Architecture

Three layers, one published package:

1. **Runtime** - state machine, retry caps, capacity pause/resume, worktree management, scope enforcement, gate runner, auto-merge with conflict abort. Project-agnostic.
2. **Agent adapters** - pluggable `Agent` interface; the default Claude Code adapter ships in the box. Future agents (Codex, OpenCode, custom) implement the same interface.
3. **Project config** - a typed `manifest.ts` per repo declares base branch, agent preferences, gates, sandbox setup, branch policy, and prompt files. Markdown plans live under `.choirmaster/plans/`; generated `*.tasks.json` files are the validated execution contracts.

The repo is a pnpm workspace with internal modules (`packages/core`, `packages/agent-claude`, `packages/cli`); `pnpm build` bundles them into the single published `choirmaster` package.

```
.choirmaster/
├─ manifest.ts            # typed defineProject({...})
├─ prompts/               # planner.md, plan-reviewer.md, implementer.md, reviewer.md
├─ plans/
│  ├─ 2026-05-foo.md      # human-authored plan input
│  └─ 2026-05-foo.tasks.json  # generated execution contract
└─ runs/<run-id>/         # per-run state, logs (gitignored)
```

## Install

```bash
# recommended: project-local CLI + manifest types
npm install --save-dev choirmaster

# optional: global CLI for convenience
npm install -g choirmaster
```

If you install globally, still add ChoirMaster to the project as a dev dependency so `.choirmaster/manifest.ts` can resolve `import { ... } from 'choirmaster'`. If you install only in the project, use `npx choirmaster ...`.

You also need the `claude` CLI installed and authenticated. The bundled Claude adapter shells out to it.

## Quickstart

```bash
# scaffold .choirmaster/ in your project
choirmaster init

# edit .choirmaster/manifest.ts (set base branch, gates, retry caps)
# write what you want done in markdown
# (a worked example lives at .choirmaster/plans/example.md)

# plan-then-run from a markdown plan: the planner agent compiles it
# into a validated tasks file, the runtime executes it
choirmaster run .choirmaster/plans/example.md

# alternatively: just plan, review the generated tasks file, then run
choirmaster plan .choirmaster/plans/example.md
choirmaster run .choirmaster/plans/example.tasks.json

# resume a paused or interrupted run
choirmaster run --resume <run-id>

# skip blocked tasks instead of halting
choirmaster run .choirmaster/plans/example.md --continue-on-blocked

# leave each task on its branch (don't auto-merge into base)
choirmaster run .choirmaster/plans/example.md --no-auto-merge
```

### Where it's going

- Plan authoring help: templates, `doctor`, or an interactive plan writer that helps turn rough intent into a strong markdown plan
- Plan reviewer loop: a second agent reviews the generated task contract before execution
- Safer plan-level branch flow, likely `current branch -> plan branch -> task branches -> plan branch`
- Daily workflow commands: `status`, `logs`, `inspect`, `retry`, and `reset`
- `choirmaster run --issue N` - GitHub issue input feeding the same planner pipeline
- Per-role engine flags (`--implementer codex`, `--reviewer claude:opus`)
- `--sandbox docker` for hard isolation

## Packages

One published package: [`choirmaster`](./packages/cli) - the CLI, the runtime, the Claude adapter, and the public types, all in one install.

The monorepo keeps the layers separated internally so future agent adapters (Codex, OpenCode, custom engines) and sandbox providers (Docker) can grow without changing the install story:

- [`packages/core`](./packages/core) - runtime substrate: types, state machine, gate runner, worktree management. Bundled into `choirmaster`; not published separately.
- [`packages/agent-claude`](./packages/agent-claude) - Claude Code agent. Bundled into `choirmaster`; not published separately.
- [`packages/cli`](./packages/cli) - the published `choirmaster` package. Bundles core + agent-claude + the CLI bin.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## Acknowledgments

ChoirMaster grew out of a local orchestrator I built for [CoreHue](https://corehue.co) to run multi-step coding work while I was away from the keyboard.

It is also shaped by ideas from agent orchestration work such as [Sandcastle](https://github.com/mattpocock/sandcastle), [LangGraph](https://github.com/langchain-ai/langgraph), [Self-Refine](https://arxiv.org/abs/2303.17651), and Anthropic's [agent/sub-agent patterns](https://docs.claude.com/en/api/agent-sdk/overview). ChoirMaster's focus is deliberately narrow: turn a reviewed task plan into gated, scoped, resumable commits in a local repo.

## License

MIT
