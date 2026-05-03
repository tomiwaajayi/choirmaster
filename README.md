# ChoirMaster

> Write a markdown plan, get scoped, gated, reviewable agent work.

ChoirMaster is a local CLI for developers and small teams who want to use AI coding agents on real codebases without losing the day to scope drift, broken gates, mystery edits, or unrecoverable runs.

The happy path is markdown-first: you write a plan, run `choirmaster run <plan.md>`, and ChoirMaster turns it into a validated task contract before executing it. Each task then moves through implementer → deterministic gates (typecheck / test / audit) → reviewer → commit → branch policy, all in isolated git worktrees.

The generated `*.tasks.json` file is still there, readable, and safe to inspect when you run `choirmaster plan`. It is the execution contract, not the normal user-facing surface.

The agents do the work. ChoirMaster owns the loop, the gates, the worktrees, and the merges.

## Status

Pre-alpha. The `0.3.x` line is published and dogfooded by this repo. APIs will still change.

## Who it's for

Solo developers, indie hackers, and small teams running scoped docs work, tests, refactors, migrations, and cleanup tasks on their own codebases. You write or review the plan, you review the diffs, you ship. ChoirMaster does the mechanical bits in between, inside the scope you defined.

## What it isn't

- **Not a hosted service or SaaS.** It's a local CLI. Runs on your machine. State lives in your repo and your filesystem.
- **Not a Claude or Codex replacement.** Today it ships with a Claude Code adapter and shells out to the `claude` CLI you already have installed and authenticated. Codex and other providers are planned behind the same adapter interface.
- **Not a "give me a goal, I'll do everything" agent.** You provide the plan, set the scope, and read the diffs. ChoirMaster only executes work that fits inside the contract generated from that plan.
- **Not telemetry-bearing.** No analytics, no phone-home, no accounts. The repo is the entire product.

## What you get out of the box

- **Markdown-first planning.** `choirmaster run <plan.md>` plans and runs in one flow. `choirmaster plan <plan.md>` stops after generating the task contract so you can review it first.
- **Live markdown completions.** `cm completions <shell>` installs shell glue for zsh, bash, fish, PowerShell, and Nushell so `cm run @exa<Tab>` can suggest markdown files while you type. Without completion, use an explicit path or an exact `@` reference.
- **Typed task contracts.** Each generated `*.tasks.json` declares branches, worktrees, allowed and forbidden paths, gates, dependencies, retry limits, and definitions of done. The runtime validates the whole file before any task starts.
- **Hard scope enforcement.** Edits outside `allowed_paths` are caught after the agent's turn and the worktree is reverted. The check looks at committed + staged + unstaged + untracked, so an agent that ignores the prompt and commits anyway is still rolled back.
- **Planner mutation guard.** Planning runs against the real repo, so ChoirMaster snapshots git-visible state plus configured forbidden paths before and after the planner turn. Rogue planner edits block the run.
- **Project-wide safeguards.** `forbiddenPaths` and `strictInstructions` declared once in your manifest apply to every task: `.env*` always blocked, "never run pnpm install" always in the prompt.
- **Deterministic gates.** Typecheck, test, audit scripts run after every implementer turn. Failures route back to the implementer with the failure summary; the reviewer never sees broken code.
- **Sandbox prepare hook.** Fresh worktrees can run setup once before any agent turn, e.g. `pnpm install --frozen-lockfile`, so real project gates have dependencies available.
- **Setup diagnostics.** `choirmaster doctor` checks the repo, manifest, branch, prompts, agents, gates, sandbox, gitignore, and Anthropic DNS before you spend a model turn.
- **Recoverable everywhere.** Hit Claude's rate limit mid-run? The orchestrator pauses cleanly and resumes from the same phase on the next run. Killed the process? `choirmaster run --resume <run-id>` picks up where it left off.
- **Configurable branch policy.** Completed tasks can merge into the base branch, fast-forward the base, or stay on task branches for manual review.
- **Per-task git worktrees.** Tasks never touch your main checkout. Inspect any task's branch independently.
- **One package.** The CLI, runtime, Claude adapter, and public types ship as `choirmaster`.

## Architecture

Three layers, one published package:

1. **Runtime** - state machine, retry caps, capacity pause/resume, worktree management, scope enforcement, gate runner, auto-merge with conflict abort. Project-agnostic.
2. **Agent adapters** - pluggable `Agent` interface; the default Claude Code adapter ships in the box. Future agents (Codex, OpenCode, custom) implement the same interface.
3. **Project config** - a typed `manifest.ts` per repo declares base branch, agent preferences, gates, sandbox setup, branch policy, and prompt files. Markdown plans can live anywhere in the repo; `.choirmaster/plans/` is the scaffolded convention. Generated `*.tasks.json` files live under `.choirmaster/tasks/` as validated execution contracts.

The repo is a pnpm workspace with internal modules (`packages/core`, `packages/agent-claude`, `packages/cli`); `pnpm build` bundles them into the single published `choirmaster` package.

```
.choirmaster/
├─ manifest.ts            # typed defineProject({...})
├─ prompts/               # planner.md, plan-reviewer.md, implementer.md, reviewer.md
├─ plans/
│  └─ 2026-05-foo.md      # human-authored plan input
├─ tasks/
│  └─ 2026-05-foo.tasks.json  # generated execution contract
└─ runs/<run-id>/         # per-run state, logs (gitignored)
```

For teams, commit the parts that define shared behavior: `manifest.ts`,
`prompts/`, and any markdown plans the team should reuse. Generated
contracts in `tasks/` and run state in `runs/` are ignored by default and
should stay local to each developer.

## Install

```bash
# project-local install (recommended so manifest.ts can import from choirmaster)
npm install --save-dev choirmaster
pnpm add --save-dev choirmaster
yarn add --dev choirmaster

# optional global CLI for convenience
npm install -g choirmaster
pnpm add -g choirmaster
yarn global add choirmaster
```

If you install globally, still add ChoirMaster to the project as a dev dependency so `.choirmaster/manifest.ts` can resolve `import { ... } from 'choirmaster'`. The global install gives you the `cm` command everywhere; the project install gives your repo's manifest its types and runtime imports.

Every command is exposed as both `choirmaster` and the shorter `cm` alias. If you only install project-locally, run through your package manager:

```bash
npx choirmaster --help
pnpm exec choirmaster --help
yarn choirmaster --help
```

You also need the `claude` CLI installed and authenticated. The bundled Claude adapter shells out to it.

### Shell Completions

ChoirMaster owns the matching logic through `cm __complete markdown @query`, and each shell owns how live suggestions are displayed. Live completions work best with a global install because your shell needs to call `cm` from whatever repo you are typing in.

Install the adapter for your shell:

```bash
# zsh
echo 'eval "$(cm completions zsh)"' >> ~/.zshrc

# bash
echo 'eval "$(cm completions bash)"' >> ~/.bashrc
```

```fish
# fish
mkdir -p ~/.config/fish/completions
cm completions fish > ~/.config/fish/completions/choirmaster.fish
```

```powershell
# PowerShell
New-Item -ItemType Directory -Force (Split-Path $PROFILE)
cm completions powershell >> $PROFILE
```

```nu
# Nushell
mkdir ~/.config/nushell
cm completions nushell | save --append ~/.config/nushell/config.nu
```

After opening a new shell, `cm run @exa<Tab>` and `cm plan @exa<Tab>` suggest matching markdown files from anywhere in the repo. At execution time, `@` references must be exact so ChoirMaster does not guess the wrong file when completions are unavailable. If your shell is not listed, it can still call the stable protocol: `cm __complete markdown @exa`.

## Quickstart

The examples below use `choirmaster`. Use `cm` for the shorter alias, or prefix with `npx`, `pnpm exec`, or `yarn` if you installed only in the project.

```bash
# scaffold .choirmaster/ in your project
choirmaster init

# edit .choirmaster/manifest.ts (base defaults to current branch; set gates/retry caps)
# draft what you want done in markdown, with concise questions
# (a worked example lives at .choirmaster/plans/example.md)
choirmaster draft --interactive "add onboarding notes for new contributors"

# or create a quick editable scaffold without questions
choirmaster draft "add onboarding notes for new contributors"

# or draft from existing notes / an issue body
choirmaster draft --from notes.md

# non-interactive drafts ask you to answer or delete clarifying questions before running
# use --output <path.md> when you want the plan somewhere else

# check your setup before invoking an agent
choirmaster doctor

# skip DNS checks when offline or behind restricted network policy
choirmaster doctor --skip-network

# plan-then-run from a markdown plan: the planner agent compiles it
# into a validated tasks file, the runtime executes it
choirmaster run @example

# or use the explicit path
choirmaster run .choirmaster/plans/example.md

# alternatively: just plan, then review the generated task contract
choirmaster plan @example

# resume a paused or interrupted run
choirmaster run --resume <run-id>

# skip blocked tasks instead of halting
choirmaster run .choirmaster/plans/example.md --continue-on-blocked

# leave each task on its branch (don't auto-merge into base)
choirmaster run .choirmaster/plans/example.md --no-auto-merge
```

### Where it's going

- Agent-generated follow-up questions on top of the deterministic interactive draft flow
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
