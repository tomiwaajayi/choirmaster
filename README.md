# ChoirMaster

> Write a plan, ship the work. An orchestrator for AI coding agents.

ChoirMaster is a local CLI for indie developers and small teams who want to run multi-step refactors with AI coding agents without losing the day to scope drift, audit failures, and merge conflicts.

You author a tasks file (a `tasks.json` describing each unit of work, its allowed paths, and its definition of done). ChoirMaster drives each task through implementer → deterministic gates (typecheck / test / audit) → reviewer → commit → merge, all in isolated git worktrees. When something goes wrong, every state is recoverable; when capacity runs out, every retry counter is preserved.

A planner agent that turns a markdown plan or a GitHub issue *into* a tasks file is on the roadmap; for now you write the tasks file by hand (the `init` scaffold ships an example).

The agents do the work. ChoirMaster owns the loop, the gates, the worktrees, and the merges.

## Status

Pre-alpha. Active development. APIs will change.

## Who it's for

Solo developers, indie hackers, and small teams running serious refactors on their own codebases. You write the plan, you review the diffs, you ship. ChoirMaster does the mechanical bits in between, inside the scope you defined.

## What it isn't

- **Not a hosted service or SaaS.** It's a local CLI. Runs on your machine. State lives in your repo and your filesystem.
- **Not a Claude or Codex replacement.** It calls the official `claude` and `codex` CLIs you already have installed and authenticated. Your subscription, your auth, your rate limits.
- **Not a "give me a goal, I'll do everything" agent.** You author the plan, you set the scope, you read the diffs. ChoirMaster only executes work that fits inside the contract you (or the planner agent operating under your review) approved.
- **Not telemetry-bearing.** No analytics, no phone-home, no accounts. The repo is the entire product.

## What you get out of the box

- **Typed task contracts.** Each task in your `tasks.json` declares its branch, worktree, allowed and forbidden paths, gates, and definition of done. The runtime reads these and orchestrates the rest.
- **Hard scope enforcement.** Edits outside `allowed_paths` are caught after the agent's turn and the worktree is reverted. The check looks at committed + staged + unstaged + untracked, so an agent that ignores the prompt and commits anyway is still rolled back.
- **Project-wide safeguards.** `forbiddenPaths` and `strictInstructions` declared once in your manifest apply to every task: `.env*` always blocked, "never run pnpm install" always in the prompt.
- **Deterministic gates.** Typecheck, test, audit scripts run after every implementer turn. Failures route back to the implementer with the failure summary; the reviewer never sees broken code.
- **Recoverable everywhere.** Hit Claude's rate limit mid-run? The orchestrator pauses cleanly and resumes from the same phase on the next run. Killed the process? `choirmaster run --resume <run-id>` picks up where it left off.
- **Auto-merge between tasks.** Each completed task merges into your base branch, so subsequent tasks fork from the latest state and see the prior work.
- **Per-task git worktrees.** Tasks never touch your main checkout. Inspect any task's branch independently.

A planner agent (markdown plans / GitHub issues → tasks file) is on the roadmap and is the next major slice.

## Architecture

Three layers, one published package:

1. **Runtime** - state machine, retry caps, capacity pause/resume, worktree management, scope enforcement, gate runner, auto-merge with conflict abort. Project-agnostic.
2. **Agent adapters** - pluggable `Agent` interface; the default Claude Code adapter ships in the box. Future agents (Codex, OpenCode, custom) implement the same interface.
3. **Project config** - a typed `manifest.ts` per repo declares base branch, agent preferences, gates, and prompt files. Tasks files (`*.tasks.json`) live under `.choirmaster/plans/`. A planner agent that turns markdown plans or GitHub issues into tasks files is on the roadmap.

The repo is a pnpm workspace with internal modules (`packages/core`, `packages/agent-claude`, `packages/cli`); `pnpm build` bundles them into the single published `choirmaster` package.

```
.choirmaster/
├─ manifest.ts            # typed defineProject({...})
├─ prompts/               # planner.md, implementer.md, reviewer.md
├─ plans/
│  └─ 2026-05-foo.md      # plan input
└─ runs/<run-id>/         # per-run state, logs (gitignored)
```

## Install

```bash
# global CLI
npm install -g choirmaster

# in your project, so manifest.ts can resolve `import { ... } from 'choirmaster'`
npm install --save-dev choirmaster
```

You also need the `claude` CLI installed and authenticated. ChoirMaster shells out to it.

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

# alternatively: just plan, review the generated tasks.json, then run
choirmaster plan .choirmaster/plans/example.md
choirmaster run .choirmaster/plans/example.tasks.json

# resume a paused or interrupted run
choirmaster run --resume <run-id>

# skip blocked tasks instead of halting
choirmaster run .choirmaster/plans/example.md --continue-on-blocked

# leave each task on its branch (don't auto-merge into base)
choirmaster run .choirmaster/plans/example.md --no-auto-merge
```

### Coming soon

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

ChoirMaster grew out of a local orchestrator I built for CoreHue to run multi-step coding work while I was away from the keyboard.

It is also shaped by ideas from agent orchestration work such as [Sandcastle](https://github.com/mattpocock/sandcastle), [LangGraph](https://github.com/langchain-ai/langgraph), [Self-Refine](https://arxiv.org/abs/2303.17651), and Anthropic's [agent/sub-agent patterns](https://docs.claude.com/en/api/agent-sdk/overview). ChoirMaster's focus is deliberately narrow: turn a reviewed task plan into gated, scoped, resumable commits in a local repo.

## License

MIT
