# ChoirMaster Roadmap

ChoirMaster is a local orchestrator for AI coding agents. Its job is not to be a magical autonomous engineer. Its job is to make agent-assisted coding operational: scoped tasks, isolated worktrees, deterministic gates, independent review, recoverable state, and clear logs.

## North Star

ChoirMaster should become the local agentic workbench engineers can trust for everyday coding work:

> I have a reviewed task plan. Run it safely, in branches, with gates, reviews, resume, logs, and no scope drift.

The strongest version of ChoirMaster is boring in the best way. It should let an engineer hand off well-scoped work, go AFK, and come back to branches, commits, logs, and reviewable outcomes rather than mystery edits.

## Target Experience

A developer should be able to install ChoirMaster, initialize a repo, write or generate a markdown plan, and get a safe reviewable branch without learning the task-file schema first.

ChoirMaster should help the user write a good plan, not just execute one.

The markdown plan is the human authoring surface. It can live anywhere in the repo; `.choirmaster/plans/` is only the scaffolded convention. Generated `*.tasks.json` contracts live under `.choirmaster/tasks/`; the runtime owns them, the user does not have to.

### Current 0.3.x Surface

- Single-package install: global CLI (`npm install -g choirmaster`) or project dev dependency (`npm install -D choirmaster` with `npx choirmaster`).
- `choirmaster` and `cm` both work as first-class command names.
- Markdown-first: `choirmaster run <plan.md>` is the primary path; `<tasks.json>` is the advanced/debug surface.
- `choirmaster draft "goal"` and `choirmaster draft --from notes.md` create editable markdown plan skeletons before any model turn.
- `choirmaster doctor` checks local setup before the user spends tokens on an agent run.
- Repo-wide markdown shorthand: `cm run @example` can resolve a markdown plan without requiring the user to remember the full path.
- Live markdown completions for common shells: zsh, bash, fish, PowerShell, and Nushell all call the same `cm __complete markdown @query` protocol.
- `choirmaster init` defaults `manifest.base` to the current branch, falling back to `main` only when no branch can be detected.
- Visible self-dogfood config in this repo (`.choirmaster/`), proving the runtime against itself.
- Sandbox prepare hook for real worktrees (e.g. `pnpm install --frozen-lockfile`).

### Near-Term 0.3.x Direction

- Interactive plan interviews: bounded question batches with recommended defaults that turn rough intent into a reviewable markdown plan without asking endless questions.
- Safer plan-level branch behavior decided and documented: most likely a flow like `current branch -> plan branch -> task branches -> plan branch` so a random first run never mutates `main` by surprise.

## Current Reality

Today, ChoirMaster is markdown-first for normal use. A user can run `choirmaster run <plan.md>` and the planner turns that markdown into a validated `*.tasks.json` execution contract before the runtime starts.

Users can also run `choirmaster plan <plan.md>` to generate the task file under `.choirmaster/tasks/` without executing it, then inspect or edit the generated contract before running `choirmaster run <tasks.json>`. The task file is still deliberately readable, but it is no longer the primary thing a new user should have to author by hand.

The plan-reviewer loop and GitHub issue planning are still future work. GitHub issues should eventually feed the same markdown-to-task pipeline rather than creating a second planning system.

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
- Single published `choirmaster` package: CLI, runtime, and Claude adapter bundled into one install.
- `cm` alias ships alongside `choirmaster`.
- `*.tasks.json` validation runs before any task starts, with cycle detection and unsafe-path rejection.
- Markdown planner: `choirmaster plan <plan.md>` and `choirmaster run <plan.md>` decompose a markdown plan into a validated tasks file. Mutation guard refuses any planner edit outside `.choirmaster/plan-output.json`, including changes to gitignored files matching `forbiddenPaths`.
- Markdown drafting: `choirmaster draft "goal"` and `choirmaster draft --from notes.md` generate editable markdown plan skeletons with concise clarifying questions and recommended defaults.
- Markdown shorthand and completions: `@query` resolves markdown plans anywhere in the repo, and generated shell completion scripts provide live `@query` suggestions for zsh, bash, fish, PowerShell, and Nushell.
- Init branch defaults: `choirmaster init` initializes `manifest.base` from the current branch and escapes unusual branch names safely; detached or non-git directories fall back to `main`.
- Sandbox prepare hook: `worktreeSandbox({ prepare: { command: 'pnpm install --frozen-lockfile' } })` runs once per fresh worktree before any agent turn. Prepare failure blocks the task immediately instead of consuming implementer attempts.
- Duplicate gate-failure detection: two consecutive attempts with the same normalized failure signature block the task instead of burning the rest of the retry budget on an environment problem.
- First successful self-dogfood: ChoirMaster ran a markdown plan against its own repo, generated tasks, ran sandbox prepare, passed `pnpm typecheck` / `pnpm test` / `pnpm build` gates, and merged a docs task branch onto `main`.
- First `choirmaster doctor`: fast setup diagnostics for repo state, manifest loading, base branch, prompt files, configured agents, Claude CLI presence, Anthropic DNS, gates, sandbox, gitignore, and forbidden paths.

## Phase 0: Finish the Trust Core

Goal: keep the state machine safe, recoverable, and regression-tested as real dogfood uncovers edge cases.

Remaining work:

- Deep preflight + diagnostics layer: the first `doctor` command exists, but the runtime still needs to distinguish capacity, missing CLI auth, offline network, DNS/API failure, and true timeout during actual agent turns. Today several of these collapse into generic "no output" or "timeout" behaviour, which is confusing when a user comes back to a paused run AFK. The runtime should classify each failure mode and surface the right remediation (re-auth, reconnect, reset, retry, wait).
- Continue tightening blocked and resume messages as new failure modes appear.
- Keep adding focused state-machine regression tests whenever a resume, gate, reviewer, sandbox, or planner guard bug is found.

Success criteria:

- Interrupted runs never skip required checks.
- Scope violations cannot be committed silently.
- A user can understand why a task blocked and what to do next.
- Each failure exit names what to do next: re-authenticate, reconnect, wait for capacity, or reset.

## Phase 1: Daily Local Use

Goal: make the markdown-first CLI surface excellent for real local work.

Core commands:

- `choirmaster init`
- `choirmaster doctor`
- `choirmaster draft "goal"` and `choirmaster draft --from notes.md`
- `choirmaster run <plan.md>`
- `choirmaster plan <plan.md>`
- `choirmaster run <tasks.json>` as the advanced/debug path
- `choirmaster run --resume <run-id>`
- `cm run @query` and `cm plan @query` for matching markdown plans anywhere in the repo
- `cm completions <zsh|bash|fish|powershell|nushell>` for live `@query` shell suggestions

Needed polish:

- Agent-assisted plan interviews: bounded question batches with recommended defaults, especially for migrations and broad goals.
- Clear plan authoring guidance, with examples of good and bad plans.
- Clear task schema documentation for users who want to inspect or edit generated contracts.
- Examples for TypeScript, Python, Rails, and generic shell-gated projects.
- Better log layout and run summaries.
- Strong defaults in the scaffolded manifest.
- Documented branch policies and retry limits.
- Simple recipes for common work: docs cleanup, test coverage, refactor, migration slice.
- Keep expanding shell integration where users actually work: VS Code terminals, JetBrains terminals, PowerShell profiles, Nushell configs, and any future completion protocol that can call `cm __complete`.

Success criteria:

- A solo engineer can install ChoirMaster globally or as a project dev dependency, initialize any repo, write a small markdown plan, and run a real task safely without learning the task-file schema first.

## Phase 2: Markdown-First Planner Pipeline

Goal: make markdown plans high-quality, reviewable inputs rather than just accepted inputs.

The first markdown planner is shipped in `0.3.0`. The remaining work is to make plan generation safer, more helpful, and easier to review before execution.

This phase has two separable shippables.

### Phase 2A: Markdown Planner (Shipped in 0.3.0)

- `choirmaster plan <plan.md>`
- `choirmaster run <plan.md>` as the main user-facing workflow.
- Planner agent decomposes a markdown plan into `*.tasks.json`.
- User can review or edit the generated task file before execution.
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

### Plan-level branch policy

Today branch policy is a per-task concern (`headOnly`, `perTaskMerge`, `perTaskBranch`). A plan needs its own layer above that, because the right rejoin shape depends on how tasks relate inside the plan, not just on a single task's preference.

A plan should declare one of:

- **Per-task**: each task merges directly into the base branch as it completes. Best when tasks are independent and the user is happy to ship each one as soon as it's green.
- **Plan branch**: every task in the plan merges into a shared `plan/<name>` branch; that branch is what eventually merges (or opens a PR) against the base. Best when tasks share context and shouldn't land piecemeal.
- **Task branches**: nothing auto-merges; each task lives on its own branch and the user merges manually. Best for review-heavy plans.

Dependencies matter here: dependent tasks usually want a cumulative base (plan branch), so a later task forks from a tree that already includes its prerequisites. Independent tasks can stay separate longer without losing parallelism.

The planner emits the plan-level policy at generation time; the user can override in the plan markdown or at run time.

Success criteria:

- A user can write intent in markdown and get a conservative, reviewable task plan.
- A user can run a markdown plan without learning the task-file schema first.
- The planner can be Claude, Codex, or any future adapter without changing the runtime.
- The plan, not just individual tasks, decides how completed work rejoins the base branch.

## Phase 3: Everyday Workflow Commands

Goal: make ChoirMaster comfortable to use throughout a normal engineering day.

Commands to add:

- `choirmaster status`
- `choirmaster logs <run-id> [task-id]`
- `choirmaster inspect <run-id> <task-id>`
- `choirmaster retry <run-id> <task-id>`
- `choirmaster reset <run-id> <task-id>`

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
- **Isolated planner sandbox.** Move planner execution into its own planning sandbox (a dedicated git worktree or fully sandboxed temp directory) so the planner can inspect the repo and write only the generated task contract, without any ability to mutate the user's working branch. The Phase 2A guard hashes git-visible state plus configured `forbiddenPaths` and is enough for everyday use, but it cannot reach files that are both gitignored AND outside `forbiddenPaths`. Sandboxing closes that residual gap by removing the "real project root" entirely from the planner's writable surface.

Success criteria:

- Users can choose a stricter execution profile when the repo or task requires it.
- The planner cannot, by construction, mutate any file on the user's working branch.

## Phase 6: Agent Ecosystem

Goal: make ChoirMaster the stable orchestration layer while agents remain pluggable.

Role and model flexibility:

- First-class per-role config for planner, plan reviewer, implementer, and reviewer.
- Per-role model options such as effort, reasoning depth, timeout, and provider-specific extras.
- CLI overrides for temporary model swaps without editing `manifest.ts`.
- Clear logs that show which engine and model handled each role and phase.

Adapters and integrations:

- Mature the built-in Claude adapter.
- Add a Codex adapter.
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

- Keep unit coverage strong for task-file validation, scope checking, handoff validation, review validation, branch-policy outcomes, and limit resolution.
- Expand state-machine tests for resume paths with fake agents, real temp git repos, and real shell gates.
- Add or preserve fixtures for capacity pause, killed process, scope violation, gate failure, reviewer block, final-verify, planner mutation guards, and branch-policy conflict.

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

- `0.2.x`: Trust core stabilized enough to dogfood: final-verify resume fixed, task-file validation, resume tests, and safer runtime guardrails.
- `0.3.0`: Single-package install plus markdown-first planning: `choirmaster run <plan.md>` compiles a markdown plan into a validated task file and runs it.
- `0.3.x`: Plan authoring help, `cm` alias, live `@query` completions, doctor polish, safer branch defaults, and fixes discovered through continued self-dogfood.
- `0.3.5`: Patch line for the live init-base bug: new scaffolds default `manifest.base` to the current branch instead of assuming `main`.
- `0.4.x`: Daily local use polished: plan/task docs, examples, better logs, status/logs/inspect basics.
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
2. Markdown-first authoring.
3. Local run ergonomics and recovery commands.
4. Plan-level branch flow.
5. GitHub/team integration.
6. Hard sandboxing and stronger guardrails.
7. Broader agent ecosystem.

ChoirMaster wins if it becomes the tool engineers trust to operationalize AI coding work, not because it promises full autonomy, but because it makes delegated coding safe, observable, recoverable, and routine.
