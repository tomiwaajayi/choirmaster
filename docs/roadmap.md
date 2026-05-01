# ChoirMaster Roadmap

ChoirMaster is a local orchestrator for AI coding agents. Its job is not to be a magical autonomous engineer. Its job is to make agent-assisted coding operational: scoped tasks, isolated worktrees, deterministic gates, independent review, recoverable state, and clear logs.

## North Star

ChoirMaster should become the local agentic workbench engineers can trust for everyday coding work:

> I have a reviewed task plan. Run it safely, in branches, with gates, reviews, resume, logs, and no scope drift.

The strongest version of ChoirMaster is boring in the best way. It should let an engineer hand off well-scoped work, go AFK, and come back to branches, commits, logs, and reviewable outcomes rather than mystery edits.

## Current Reality

Today, ChoirMaster runs authored task files. A user writes a `*.tasks.json` file that describes each unit of work, including allowed paths, forbidden paths, gates, branch, worktree, and definition of done.

The planner flow is the next release blocker. Markdown plans should compile into task files, and GitHub issues should later feed the same planner pipeline. The executable artifact remains the task contract, but the human authoring surface should become markdown.

The runtime is already shaped around role-specific agents: planner, plan reviewer, implementer, and reviewer. Claude is the first bundled adapter, but the product goal is that any supported provider can fill any role.

## Non-Goals

- ChoirMaster is not a hosted service or SaaS.
- ChoirMaster is not a "give me a goal, I'll do anything" agent.
- ChoirMaster is not a Claude, Codex, or IDE replacement.
- ChoirMaster should not collect telemetry by default.
- ChoirMaster should not hide the task contract from the user.

## Product Principles

- Trust beats autonomy. Never skip scope checks, gates, or review to look smart.
- Recovery is a feature. Capacity pauses, killed processes, blocked tasks, and conflicts should be understandable and resumable.
- Local first. State, logs, worktrees, and branches live in the user's repo and filesystem.
- Plans are contracts. Every task should have a clear scope, definition of done, and recovery story.
- Task files stay human-editable. Generated task files should remain readable, reviewable, and safe to hand-edit.
- Agents are replaceable. ChoirMaster owns orchestration; Claude, Codex, and other agents are workers behind interfaces.
- Roles choose agents. Planner, plan reviewer, implementer, and reviewer are independent slots; each slot should be able to use a different provider, model, and effort level.
- Provider details stay behind adapters. Model names, permission flags, streaming protocols, capacity signals, and tool formats belong in the adapter, not the runtime.
- Small teams first. Optimize for solo developers, indie hackers, and small teams before enterprise ceremony.

## Agent Choice Goal

ChoirMaster should make mixed-agent workflows normal, not special-case behavior.

A project should be able to configure Claude as the implementer and Codex as the reviewer:

```ts
agents: {
  planner: claude('sonnet'),
  planReviewer: codex('gpt-5.4', { reasoningEffort: 'high' }),
  implementer: claude('opus'),
  reviewer: codex('gpt-5.4', { reasoningEffort: 'high' }),
}
```

The same project should also be able to switch to Claude for every role, Codex for every role, or any future provider adapter without changing the orchestration loop.

Non-negotiables:

- Per-role agent selection is first-class config, not a hidden CLI hack.
- Per-role model selection is explicit and flexible.
- Planner, plan reviewer, implementer, and reviewer can use different engines.
- Runtime behavior must be engine-agnostic: invoke role, receive structured output, enforce gates, continue the state machine.
- CLI overrides should eventually support quick experiments such as `--implementer claude:opus --reviewer codex:gpt-5.4`.
- New providers should implement the public `Agent` interface rather than requiring runtime changes.

## Recently Shipped

These are no longer roadmap items, but they shape the remaining work:

- Comprehensive scope checks now include committed, staged, unstaged, and untracked files.
- Reverts target the captured base SHA, so committed violations are discarded.
- Runtime base handling now reads `manifest.base` and refuses to run from the wrong root branch.
- Branch policy completion is awaited before the next task starts.
- Agent invocations receive tool allowlists and per-turn timeouts.
- Handoff and review JSON files are validated before use.
- Worktree reuse checks branch identity.
- `READY` reviews with populated issues are treated as blocked.
- `choirmaster run --resume <run-id>` exists and rejects ambiguous task-file plus resume usage.
- Implementer attempts distinguish started from completed work via `completed_attempts`.
- Reviewer iterations distinguish started from completed work via `completed_review_iterations`.
- Retry caps can come from task overrides, manifest limits, or built-in defaults.
- README and CLI help now describe the implemented surface rather than planned commands.

## Phase 0: Finish the Trust Core

Goal: make the runtime safe enough to dogfood on ChoirMaster itself.

Remaining work:

- Verify and test resumable final-verify handling.
- Add focused resume tests for implementer, gate, reviewer, implementer-fix, final-verify, and killed-process paths.
- Add validation for `*.tasks.json` before a run starts.
- Dogfood ChoirMaster on this repository with small documentation and CLI tasks.
- Continue tightening blocked and resume messages as new failure modes appear.

Success criteria:

- Interrupted runs never skip required checks.
- Scope violations cannot be committed silently.
- A user can understand why a task blocked and what to do next.

## Phase 1: Daily Local Use

Goal: make the current CLI surface excellent for real local work.

Core commands:

- `choirmaster init`
- `choirmaster run <tasks.json>`
- `choirmaster run --resume <run-id>`

Needed polish:

- Clear task schema documentation.
- Examples for TypeScript, Python, Rails, and generic shell-gated projects.
- Better log layout and run summaries.
- Strong defaults in the scaffolded manifest.
- Documented branch policies and retry limits.
- Simple recipes for common work: docs cleanup, test coverage, refactor, migration slice.

Success criteria:

- A solo engineer can install ChoirMaster globally, initialize any repo, author a task file, and run a small real task safely.

## Phase 2: Markdown-First Planner Pipeline

Goal: turn human markdown plans into executable task contracts.

This phase is a release blocker for the next public package. ChoirMaster should not ask new users to hand-author JSON as the primary path.

This phase has two separable shippables.

### Phase 2A: Markdown Planner

- `choirmaster plan <plan.md>`
- `choirmaster run <plan.md>` as the main user-facing workflow.
- Planner agent decomposes a markdown plan into `*.tasks.json`.
- User reviews or edits the generated task file before execution.
- Task files remain conservative, readable, and hand-editable.
- The planner role uses the same provider-agnostic `Agent` interface as implementer and reviewer roles.

### Phase 2B: Plan Reviewer

- Plan reviewer checks task scope, dependencies, definitions of done, and risk.
- Plan reviewer rejects tasks that are too broad, ambiguous, or unsafe to execute.
- Plan-review iteration caps prevent planner/reviewer loops from running forever.

Capabilities:

- Task splitting heuristics.
- Dependency detection.
- Scope tightening.
- "Too broad" rejection.
- Conservative defaults for allowed paths and gates.

Success criteria:

- A user can write intent in markdown and get a conservative, reviewable task plan.
- A user can run a markdown plan without learning the task-file schema first.
- The planner can be Claude, Codex, or any future adapter without changing the runtime.

## Phase 3: Everyday Workflow Commands

Goal: make ChoirMaster comfortable to use throughout a normal engineering day.

Commands to add:

- `choirmaster status`
- `choirmaster logs <run-id> [task-id]`
- `choirmaster inspect <run-id> <task-id>`
- `choirmaster retry <run-id> <task-id>`
- `choirmaster reset <run-id> <task-id>`
- `choirmaster doctor`

Workflow improvements:

- Better run summaries.
- Cost, token, duration, and retry stats.
- Clear task outcome table.
- Task templates for common engineering work.
- Safer manual recovery instructions.

Success criteria:

- Users do not need to inspect raw state files for normal operation.
- ChoirMaster is ready for daily local engineering use at the end of this phase, assuming Phase 0 trust work is complete.

## Phase 4: GitHub and Team Workflow

Goal: make ChoirMaster fit small-team collaboration without becoming a hosted product.

GitHub issue planning should use the same planner pipeline as Phase 2:

- GitHub issue body becomes planner input.
- Planner emits `*.tasks.json`.
- Plan reviewer tightens the task file.
- User or team approves the task file before execution.

Capabilities:

- Run from a GitHub issue.
- Create task files from labeled issues.
- Open PRs per task or per run.
- Comment summaries back to issues or PRs.
- Support branch policies: merge, leave branch, open PR.
- Respect repository ownership patterns such as CODEOWNERS where practical.
- Surface CI status in summaries.

Success criteria:

- A small team can use ChoirMaster with GitHub without inventing custom process around it.

## Phase 5: Hard Guardrails

Goal: make "safe enough to leave running" credible for more serious codebases.

Guardrails:

- Docker sandbox provider.
- Strict read/write allowlists outside of prompts.
- Secret scanning before commit.
- Configurable network policy.
- Dependency install policy.
- Lockfile policy.
- Audit trail for agent commands, files touched, gates, and commits.
- Permission profiles such as `solo`, `team`, and `strict`.

Success criteria:

- Users can choose a stricter execution profile when the repo or task requires it.

## Phase 6: Agent Ecosystem

Goal: make ChoirMaster the stable orchestration layer while agents remain pluggable.

Role and model flexibility:

- First-class per-role config for planner, plan reviewer, implementer, and reviewer.
- Per-role model options such as effort, reasoning depth, timeout, and provider-specific extras.
- CLI overrides for temporary model swaps without editing `manifest.ts`.
- Clear logs that show which engine and model handled each role and phase.

Packages and integrations:

- Mature `@choirmaster/agent-claude`.
- Add `@choirmaster/agent-codex`.
- Support custom agent adapters through the public `Agent` interface.
- Prompt packs for common review styles.
- Framework presets for common project types.

Local model adapters should wait until there is a concrete target and use case.

Success criteria:

- Users can swap agent engines per role without rewriting the orchestration workflow.
- Claude implementer plus Codex reviewer is a documented, tested configuration.
- Claude for every role and Codex for every role are also documented, tested configurations.

## Testing Strategy

Trust in ChoirMaster depends on testing the state machine, not just helper functions.

Short term:

- Unit-test task-file validation, scope checking, handoff validation, review validation, branch-policy outcomes, and limit resolution.
- Add state-machine tests for resume paths with mocked agents and gates.
- Add fixtures for capacity pause, killed process, scope violation, gate failure, reviewer block, final-verify, and branch-policy conflict.

Medium term:

- Add integration tests that run a tiny fixture repo through `choirmaster init`, `run`, and `resume`.
- Add mocked-agent transcripts so tests can assert exact phase routing without invoking real CLIs.
- Add a CI matrix for Node versions and package manager behavior.
- Add smoke tests for generated scaffold files.

## Documentation Strategy

Documentation should live in the repo first, then move to a hosted site only when the surface area justifies it.

Near-term docs under `docs/`:

- `docs/task-file-schema.md`
- `docs/config.md`
- `docs/branch-policies.md`
- `docs/resume-and-recovery.md`
- `docs/examples/typescript.md`
- `docs/examples/python.md`
- `docs/examples/rails.md`

The README should stay short: what ChoirMaster is, what works today, quickstart, and links to deeper docs.

## Versioning Strategy

Phase names are product capability phases, not exact package versions. Published package versions may move faster than this roadmap.

Suggested release milestones:

- `0.2.x`: Trust core complete enough to dogfood: final-verify resume fixed, task-file validation, resume tests, and ChoirMaster dogfooding.
- `0.3.x`: Single-package install plus markdown-first planning: `choirmaster run <plan.md>` compiles a markdown plan into a validated task file and runs it.
- `0.4.x`: Daily local use polished: schema docs, examples, better logs, status/logs/inspect basics.
- `0.5.x`: GitHub/team workflow: issue input, PR creation, comment summaries.
- `0.6.x`: Hard guardrails: Docker sandbox and stricter permission profiles.
- `1.0.0`: Stable task schema, stable config API, reliable resume semantics, documented recovery workflow, and enough dogfooding history to trust the runtime.

## Ready For Daily Use Checklist

ChoirMaster is ready for everyday engineering use when:

- The runtime can survive capacity pauses and killed processes without losing state or skipping checks.
- Task files are validated before execution.
- Logs and summaries explain exactly what happened.
- Scope checks include committed, staged, unstaged, and untracked changes.
- Reviewers never see code that failed deterministic gates.
- The CLI supports status, logs, resume, retry, and reset.
- Users can choose different agents and models for planner, implementer, and reviewer roles.
- The README describes only current behavior, with roadmap items clearly marked.
- The project dogfoods ChoirMaster on its own development.

This checklist is expected to become true around the end of Phase 3, not Phase 1.

## Sequencing

The order matters:

1. State machine correctness.
2. Local run ergonomics.
3. Markdown-first planner pipeline.
4. Daily workflow commands.
5. GitHub/team integration.
6. Hard sandboxing and stronger guardrails.
7. Broader agent ecosystem.

ChoirMaster wins if it becomes the tool engineers trust to operationalize AI coding work, not because it promises full autonomy, but because it makes delegated coding safe, observable, recoverable, and routine.
