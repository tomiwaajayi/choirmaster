# ChoirMaster

> Write a plan, ship the work. An orchestrator for AI coding agents.

ChoirMaster is a local CLI for indie developers and small teams who want to run multi-step refactors with AI coding agents without losing the day to scope drift, audit failures, and merge conflicts.

You write a plan (a markdown file or a GitHub issue). ChoirMaster decomposes it into tasks, reviews the breakdown until it's tight, then drives each task through implementer → deterministic gates (typecheck / test / audit) → reviewer → commit → merge, all in isolated git worktrees. When something goes wrong, every state is recoverable; when capacity runs out, every retry counter is preserved.

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

- **Plan as input.** A structured markdown file or a GitHub issue. The planner agent decomposes it into typed task contracts; the plan-reviewer iterates until every contract is tight.
- **Hard scope enforcement.** Each task declares `allowed_paths` and `forbidden_paths`. Edits outside the contract are caught after the fact and the worktree is reverted.
- **Project-wide safeguards.** A single `forbiddenPaths` and `strictInstructions` declared once in your project manifest applies to every task: `.env*` always blocked, "never run pnpm install" always in the prompt.
- **Deterministic gates.** typecheck, test, audit scripts run after every implementer turn. Failures route back to the implementer with the failure summary; the reviewer never sees broken code.
- **Recoverable everywhere.** Hit Claude's rate limit mid-run? The orchestrator pauses cleanly and resumes from the same phase on the next run. Killed the process? The state file is the source of truth; nothing is lost.
- **Auto-merge between tasks.** Each completed task merges into your base branch, so subsequent tasks fork from the latest state and see the prior work.
- **Per-task git worktrees.** Tasks never touch your main checkout. Inspect any task's branch independently.

## Architecture

Three layers:

1. **Runtime** (`@choirmaster/core`) - state machine, retry caps, capacity pause/resume, worktree management, scope enforcement, gate runner, auto-merge with conflict abort. Project-agnostic.
2. **Plugins** - pluggable `Agent` (Claude, Codex), `Sandbox` (worktree, Docker), `BranchPolicy`, gate factories.
3. **Project config** - a typed `manifest.ts` per repo declares base branch, agent preferences, gates, prompt files. Plans live as markdown or GitHub issues.

```
.choirmaster/
├─ manifest.ts            # typed defineProject({...})
├─ prompts/               # planner.md, implementer.md, reviewer.md
├─ plans/
│  └─ 2026-05-foo.md      # plan input
└─ runs/<run-id>/         # per-run state, logs (gitignored)
```

## Install

Once published to npm:

```bash
npm install -g @choirmaster/cli
```

For now (pre-publish), clone and link:

```bash
git clone https://github.com/tomiwaajayi/choirmaster.git
cd choirmaster
pnpm install
pnpm build
pnpm link --global --filter @choirmaster/cli
choirmaster --version
```

## Quickstart

```bash
# in any project repo:
choirmaster init                              # scaffold .choirmaster/

# plan from a markdown file:
$EDITOR .choirmaster/plans/refactor.md
choirmaster plan ./plans/refactor.md          # decompose; plan-reviewer iterates
choirmaster run ./plans/refactor.md           # execute every task

# plan from GitHub issues:
gh issue create --label ready-for-agent --title "..." --body "..."
choirmaster run --label ready-for-agent

# pick agents per role:
choirmaster run ./plans/foo.md \
  --planner claude:opus \
  --implementer codex \
  --reviewer claude:opus

# sandboxed in Docker:
choirmaster run ./plans/foo.md --sandbox docker
```

## Packages

| Package | Description |
|---|---|
| [`@choirmaster/core`](./packages/core) | Runtime substrate: types, state machine, gate runner, worktree management |
| [`@choirmaster/cli`](./packages/cli) | The `choirmaster` command |

More to come: agent integrations (Claude, Codex), sandbox providers (Docker), GitHub issue integration, project templates.

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## Acknowledgments

ChoirMaster started as a hand-built orchestrator I used on my own codebase to drive a real multi-PR migration: state machine, retry caps, scope enforcement, capacity-aware resume, auto-merge with conflict abort, final-verify pass. After that runtime was working end-to-end, I came across [Matt Pocock's sandcastle](https://github.com/mattpocock/sandcastle) and noted a few nice-to-haves worth folding in over time - notably its three-mode framing for branch policies (head-only / per-task / named), prompt files with template substitution, and idle-timeout via stream parsing.

The pluggable-agent and pluggable-sandbox shapes are widespread industry patterns expressed in many places (LangChain, AutoGen, CrewAI, Anthropic's Agent SDK all carry them); ChoirMaster expresses them with its own API surface. The two projects also take opposite stances: sandcastle ships a `run()` primitive and expects you to write the orchestrator; ChoirMaster ships the orchestrator and expects you to write the plan.

Other influences include multi-agent-debate and [Self-Refine](https://arxiv.org/abs/2303.17651) literature for the implementer / reviewer / final-verify loop, [LangGraph](https://github.com/langchain-ai/langgraph) for graph-based agent orchestration, and Anthropic's [Claude Agent SDK + Sub-agents](https://docs.claude.com/en/api/agent-sdk/overview) for the role decomposition pattern.

## License

MIT
