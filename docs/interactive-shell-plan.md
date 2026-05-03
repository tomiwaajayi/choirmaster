# Interactive Shell Plan

This document describes the target experience for ChoirMaster's owned CLI shell.

The product goal is simple:

```text
install choirmaster
npx cm init
npx cm

You are now inside ChoirMaster.
```

Once inside `cm`, the user should not have to remember exact paths, shell completion setup, task JSON, or long command strings. The shell should guide them with slash commands, markdown file suggestions, clear status, and resumable sessions.

## Why This Matters

Shell autocomplete is owned by the user's shell: zsh, bash, fish, PowerShell, Nushell, and terminal-specific behavior all vary. ChoirMaster can keep optional shell completions, but the best DX should not depend on the user installing shell glue.

The core experience should be owned by ChoirMaster:

- Typing `/` shows available commands.
- Typing `@` shows markdown file suggestions.
- `/run` and `/plan` can open a built-in picker when no file is passed.
- Interrupted, blocked, or paused runs tell the user exactly how to continue.
- The user stays in one focused environment for planning, running, doctoring, and resuming work.

## Target User Journey

### First Install

The happy path should feel like this:

```bash
npm install --save-dev choirmaster
npx cm init
npx cm
```

Or with a global install:

```bash
npm install -g choirmaster
cm init
cm
```

If installed globally, the user may still need the project dev dependency so `.choirmaster/manifest.ts` can resolve `import { ... } from 'choirmaster'`. The shell should detect that and explain it clearly through `/doctor`.

### Entering the Shell

Running `cm` with no args should open a polished interactive environment:

```text
ChoirMaster
repo: coral  branch: toms-playground  base: toms-playground
status: ready

cm> 
```

The shell should quickly teach itself:

```text
cm> /
  /draft    Create or refine a markdown plan
  /plan     Generate a task contract from a plan
  /run      Run a plan
  /doctor   Check setup
  /resume   Continue an interrupted run
  /help     Show commands
  /exit     Leave ChoirMaster
```

Typing `@` should show markdown files as the user types:

```text
cm> /run @dash
  @.choirmaster/plans/dashboard-state-machine.md
  @docs/dashboard-sharing.md
```

The user should not need shell completions to get this.

## Command Model

The shell command surface is intentionally small:

```text
/help
/draft
/plan
/run
/doctor
/resume
/exit
```

### `/help`

Shows the command list, examples, and the current repo context.

It should answer:

- What can I do here?
- What should I do next?
- How do I pick a plan?
- How do I resume?

### `/draft`

Creates a markdown plan.

Supported forms:

```text
/draft add email sharing to galleries
/draft --interactive add email sharing to galleries
/draft --from notes.md
```

Target behavior:

- Without `--interactive`, writes a quick editable plan skeleton.
- With `--interactive`, asks concise questions until enough context exists.
- The interview should be adaptive, not capped at a hard number like five questions.
- The interview should stop when the plan is good enough, not when every possible question is exhausted.
- For broad migrations, ask enough questions to understand scope, constraints, rollout, test strategy, and ordering.
- For small tasks, ask few or no questions.

The shell should return the path and next action:

```text
Draft plan created:
  .choirmaster/plans/add-email-sharing.md

Next:
  /run @add-email-sharing
```

### `/plan`

Generates a task contract from a markdown plan without executing it.

Supported forms:

```text
/plan
/plan @example
/plan docs/migration.md
```

Target behavior:

- With no args, open the built-in markdown picker.
- With `@`, use exact references or live suggestions inside the shell.
- Generate the task contract under `.choirmaster/tasks/`.
- Keep task JSON as inspectable internal/advanced output, not the happy path.
- Print the markdown command to continue, not the task JSON command.

Example:

```text
Task contract generated:
  .choirmaster/tasks/add-email-sharing.tasks.json

Review it if you want, then run:
  /run @add-email-sharing
```

### `/run`

Runs a markdown plan end to end.

Supported forms:

```text
/run
/run @example
/run docs/migration.md
```

Target behavior:

- With no args, open the built-in markdown picker.
- With a markdown plan, run planner first, then execute the generated task contract.
- Show progress as phases:

```text
Planning -> Implementing -> Gates -> Reviewing -> Committing
```

- Do not expose `*.tasks.json` as the normal command.
- If the run blocks, pauses, or is interrupted, print the exact resume command.

Example stopped output:

```text
Run paused: Claude capacity hit during reviewer iter 2.

To continue:
  /resume 2026-05-02T07-52-44-736-fl0b

From outside the shell:
  cm --resume 2026-05-02T07-52-44-736-fl0b
```

### `/doctor`

Checks setup without spending model tokens.

The shell should render a compact health report:

```text
Doctor
ok    git repository
ok    manifest
ok    base branch
warn  gates: no deterministic gates configured
fail  claude CLI: not found

Next:
  Install and authenticate Claude:
    claude --version
```

Target behavior:

- No agent turn.
- No network hard-fail unless the user explicitly asks for strict network checks.
- Clear remediation for every failure.

### `/resume`

Continues a stopped run.

Supported forms:

```text
/resume
/resume 2026-05-02T07-52-44-736-fl0b
```

Target behavior:

- With an id, resume that run.
- With no id, list recent resumable runs.
- Show run id, age, status, current task, and reason.

Example:

```text
Resumable runs

1. 2026-05-02T07-52-44-736-fl0b
   status: waiting_for_capacity
   task: TASK-03
   reason: reviewer capacity

2. 2026-05-01T21-13-51-652-4zk7
   status: blocked
   task: TASK-01
   reason: gates failed

Select a run: 
```

### `/exit`

Leaves the shell.

If no run is active, exit immediately.

If a run is active, ask for confirmation or stop gracefully:

```text
Run is active.

To continue later:
  cm --resume 2026-05-02T07-52-44-736-fl0b

Exit now? [y/N]
```

## Interaction Requirements

### Slash Suggestions

Typing `/` should immediately show commands.

Typing `/r` should filter to:

```text
/run
/resume
```

The user should be able to:

- Use arrow keys to move.
- Press Enter to select.
- Press Escape to close suggestions.
- Keep typing to filter.

### Markdown Suggestions

Typing `@` inside `/run` or `/plan` should show markdown file suggestions.

Rules:

- Search markdown files from the repo root, not just the current directory.
- Include tracked and untracked non-ignored markdown files.
- Exclude `.choirmaster/runs/`.
- Exclude `.choirmaster/prompts/`.
- Prefer `.choirmaster/plans/` but do not require plans to live there.
- Suggestions should render as `@repo-relative/path.md`.
- Execution should remain exact-only unless the user selects from the picker.

### Built-in Picker

`/run` and `/plan` with no args should open the picker.

The picker should:

- List markdown files.
- Filter as the user types.
- Support arrow keys.
- Show the selected path.
- Return a repo-relative path.

### Status Header

The shell should show useful context:

- Repo name.
- Current branch.
- Manifest base.
- Dirty working tree indicator.
- Last run status.
- Resumable run hint.

Example:

```text
ChoirMaster
repo: coral  branch: toms-playground  base: toms-playground  dirty: yes
resumable: 1 run

cm> 
```

### Output Style

The shell should feel calm and crisp:

- Use restrained color.
- Use clear labels.
- Avoid noisy banners.
- Keep long logs collapsible or clearly grouped.
- Show phase progress.
- Put next actions at the end.

Suggested color rules:

- Green for ok.
- Yellow for warnings.
- Red for failures.
- Cyan or blue for selected items and commands.
- Dim text for helper hints.

Avoid making the interface cute at the expense of clarity.

## Architecture Plan

The current implementation uses `readline` with Tab completion. That is a good spike, but the full shell needs an owned input loop.

### Proposed Modules

```text
packages/cli/src/interactive/
  index.ts              # shell entry point
  input.ts              # raw-mode input state machine
  render.ts             # frame, suggestions, status, help
  commands.ts           # slash command registry
  suggestions.ts        # slash + markdown suggestion logic
  runs.ts               # resumable run discovery
  theme.ts              # colors and symbols
  parser.ts             # quoted args, slash commands
  interactive.test.ts   # state-machine and parser tests
```

Keep existing non-interactive commands unchanged. The shell should dispatch to the same command functions rather than duplicating planner, runner, doctor, or draft logic.

### Input State

Track:

- Current line.
- Cursor position.
- Active suggestion kind: none, slash, markdown, run.
- Suggestion list.
- Highlighted suggestion index.
- Shell mode: idle, running command, confirm exit.

Events:

- Character input.
- Backspace/delete.
- Left/right arrows.
- Up/down arrows.
- Enter.
- Escape.
- Ctrl-C.
- Tab.

### Command Registry

Represent commands as data:

```ts
interface ShellCommand {
  name: '/run' | '/plan' | '/draft' | '/doctor' | '/resume' | '/help' | '/exit'
  summary: string
  usage: string
  run(args: string[], ctx: ShellContext): Promise<number>
}
```

Benefits:

- `/help` renders from the registry.
- Slash suggestions render from the registry.
- Tests can assert command availability from one source of truth.

### Rendering Strategy

Use a small custom renderer:

- Clear and redraw only the interactive frame when editing.
- Let long command output stream normally.
- After a command finishes, redraw prompt and status.

Avoid a large TUI dependency unless necessary. A lightweight raw-mode renderer is enough for now and keeps the package simple.

If a dependency becomes necessary, evaluate it explicitly against:

- Bundle size.
- Node 20 support.
- Cross-platform behavior.
- Testability.
- Whether it handles raw-mode cleanup on crashes.

## Implementation Status

All six implementation phases below are shipped. The notes are kept for design context and future refactors.

Shipped highlights:

- `packages/cli/src/interactive/` holds the new shell: `parser.ts`, `commands.ts`, `suggestions.ts`, `runs.ts`, `repo-context.ts`, `theme.ts`, `render.ts`, `input.ts`, `resume-picker.ts`, `route.ts`, and `index.ts`.
- The legacy `interactive.ts` is now a barrel that re-exports the new module so external callers and existing tests keep working.
- Slash commands live in a single registry that drives `/help`, slash suggestions, and dispatch routing.
- Live `/` and `@` suggestions render as the user types, with Up/Down/Tab/Enter/Esc/Ctrl-A/E/U/K bindings.
- `/run`, `/plan`, and `/resume` open first-class pickers with empty states.
- The shell sets `_CHOIRMASTER_INTERACTIVE=1` (underscore-prefixed to mark it private to ChoirMaster) so `draft`, `plan`, and `run` swap their next-step hints to the `/run` and `/resume` forms while the shell is alive.
- `runMarkdownInput` prints a one-line phase overview at the top of each plan-then-run cycle.
- Doctor labels (`[ok]`, `[warn]`, `[fail]`) are colored when stdout is a TTY and `NO_COLOR` is unset.
- Tests cover the parser, suggestion engine, run discovery, command registry, hint-style switch, doctor color labels, and the routing layer (including injected pickers).

## Implementation Phases

### Phase 1: Better Shell Skeleton  (shipped)

Goal: replace basic readline with a structured interactive shell.

Tasks:

- Move interactive code into `packages/cli/src/interactive/`.
- Add command registry.
- Add parser tests.
- Add basic status header.
- Keep current Tab suggestions working.
- Preserve `/help`, `/exit`, `/doctor`, `/draft`, `/plan`, `/run`, `/resume`.

Acceptance:

- `cm` opens the shell.
- `/help` renders from command registry.
- `/exit` exits cleanly.
- Non-interactive commands still work.

### Phase 2: Live Suggestions  (shipped)

Goal: suggestions appear while typing, not only after Tab.

Tasks:

- Add raw-mode input.
- Typing `/` opens command suggestions.
- Typing `/r` filters slash suggestions.
- Typing `@` opens markdown suggestions.
- Arrow keys move through suggestions.
- Enter accepts selected suggestion or executes command.
- Escape closes suggestions.

Acceptance:

- `/` shows command list immediately.
- `/r` filters to `/run` and `/resume`.
- `/run @exa` shows matching markdown files.
- Selecting a suggestion inserts it into the line.

### Phase 3: First-Class Pickers  (shipped)

Goal: choosing plans and runs is easy without remembering ids or paths.

Tasks:

- `/run` with no args opens markdown picker.
- `/plan` with no args opens markdown picker.
- `/resume` with no args opens resumable-run picker.
- Add recent run discovery from `.choirmaster/runs/`.
- Add empty states for no plans and no resumable runs.

Acceptance:

- User can run a plan without typing a path.
- User can resume a run without copying the run id.

### Phase 4: Run-Aware Shell  (shipped)

Goal: active runs and stopped runs feel recoverable.

Tasks:

- Shell tracks active command state.
- Ctrl-C while idle exits or asks.
- Ctrl-C during a run prints `cm --resume <run-id>`.
- Blocked, paused, or interrupted runs show `/resume <run-id>` inside shell and `cm --resume <run-id>` outside shell.
- Status header shows recent resumable runs.

Acceptance:

- A stopped run always leaves a continuation command.
- `/resume` can pick up the latest paused run.

### Phase 5: Visual Polish  (shipped, partial)

Note: the live phase tracker described below ships as a static one-line
header (`Phases: Planning -> Implementing -> Gates -> Reviewing ->
Committing`) printed at the top of each plan-then-run cycle. True live
highlighting requires phase events from the runtime and is future work.

Goal: make the shell feel good enough to be the default DX.

Tasks:

- Add colors through a tiny theme layer.
- Add phase display for `Planning`, `Implementing`, `Gates`, `Reviewing`, `Committing`.
- Compact doctor output inside shell.
- Improve error formatting.
- Add command-specific next-action hints.

Acceptance:

- The shell is pleasant to use for a full plan-run-resume cycle.
- Output stays readable when agents stream logs.

### Phase 6: Tests and Release  (shipped)

Goal: make the shell safe to ship as the primary interface.

Tasks:

- Unit tests for parser, suggestions, command registry, run discovery.
- Integration tests for `/help`, `/exit`, `/run @example`, `/resume`.
- TTY smoke test from packed tarball.
- README update.
- Roadmap update.
- Release notes.

Acceptance:

- Tests pass.
- Typecheck passes.
- Build passes.
- Packed install smoke passes.
- `cm` is documented as the recommended entry point.

## Testing Strategy

### Unit Tests

Cover:

- Slash command parsing.
- Quoted args.
- `--` end-of-options behavior.
- Slash suggestions.
- Markdown suggestions.
- Picker filtering.
- Resumable run sorting.
- Empty states.

### Integration Tests

Use a fake manifest and fake agents where possible.

Cover:

- `cm` opens and `/exit` exits.
- `/help` renders command list.
- `/run @example` routes to the same command path as `cm run @example`.
- `/plan` with picker selection writes under `.choirmaster/tasks/`.
- `/resume` with a selected run calls the existing resume command.

### Packed Smoke

Before publish:

```bash
npm pack
tmpdir=$(mktemp -d)
cd "$tmpdir"
npm init -y
npm install -D /path/to/choirmaster-*.tgz
npx cm --version
npx cm init
npx cm doctor --skip-network
npx cm
```

For the interactive smoke, script `/help` then `/exit` through a TTY if possible.

## Release Shape

This should likely ship as `0.4.0`, not a patch release, because it changes the product's default feel.

The release headline:

```text
v0.4.0 - ChoirMaster interactive shell
```

Release notes should emphasize:

- `cm` opens a first-class interactive shell.
- Slash commands.
- Owned `@` suggestions.
- Built-in plan and resume pickers.
- `cm --resume <run-id>` remains available outside the shell.

## Open Questions

- Should `cm init` eventually write `.cm/` instead of `.choirmaster/`, or keep `.choirmaster/` for clarity and package-name consistency?
- Should `/run` default to the most recent edited markdown plan if there is only one strong candidate?
- Should `/draft` become the default first action if no plans exist?
- How much agent output should stream directly inside the shell versus being summarized with log paths?
- Should task JSON execution remain hidden from `/help`, while staying available as an advanced non-interactive path?

## Claude Handover Prompt

Use this prompt when handing the implementation to another agent:

```text
You are working in /Users/tomiwa/Dev/ChoirMaster.

Context:
ChoirMaster is an agentic coding orchestrator. The product direction is now a Claude Code-style interactive shell. Running `cm` with no args should put the user inside the ChoirMaster world. The current implementation is a basic interactive prompt committed as `c4adcad feat: add interactive slash prompt`.

Current shell supports:
- `cm` opens a prompt.
- Slash commands: /draft, /plan, /run, /resume, /doctor, /help, /exit.
- Tab completion for slash commands and @ markdown references.
- Top-level `cm --resume <run-id>`.
- Blocked, paused, or interrupted runs print `cm --resume <run-id>`.

Desired next step:
Build a polished interactive shell end to end.

Product goals:
1. `cm` should feel like a polished owned CLI environment, not a plain readline loop.
2. Typing `/` should show available commands immediately while typing.
3. Typing `@` should show matching markdown plan files immediately while typing.
4. Users should not need shell completions for the core experience.
5. `/run` and `/plan` with no args should open a first-class picker.
6. `/resume` with no args should list recent resumable runs.
7. The shell should show useful repo context: repo name, current branch, manifest base, dirty state, and resumable run hints.
8. Errors should be actionable and concise.
9. Keep implementation scoped and testable.

Please inspect:
- docs/interactive-shell-plan.md
- packages/cli/src/interactive.ts
- packages/cli/src/index.ts
- packages/cli/src/markdown-ref.ts
- packages/cli/src/markdown-picker.ts
- packages/cli/src/commands/run.ts
- packages/cli/src/commands/doctor.ts
- README.md
- docs/roadmap.md

Implementation direction:
- Replace or substantially improve the current readline loop.
- Prefer a small custom raw-mode input loop or lightweight TUI approach.
- Do not rely on zsh/bash/fish shell completions for the main UX.
- Keep optional shell completions intact.
- Add tests for command parsing, live suggestion state, markdown suggestions, run discovery, and command routing.
- Preserve existing behavior for non-interactive `cm run`, `cm plan`, `cm draft`, etc.
- Do not expose tasks.json as the happy path.
- Avoid em dashes in repo text.

Acceptance criteria:
- Running `cm` opens a styled interactive shell.
- Typing `/` shows command suggestions.
- Typing `/r` filters to `/run` and `/resume`.
- Typing `@` shows markdown plan suggestions.
- Typing `/run @example` can execute the exact markdown plan reference.
- `/run` with no args opens a markdown picker.
- `/plan` with no args opens a markdown picker.
- `/resume` with no id shows recent resumable runs or a helpful empty state.
- `/help` renders a polished command list.
- `/exit` exits cleanly.
- Ctrl-C exits cleanly when idle.
- Interrupted active runs still print `cm --resume <run-id>`.
- Tests, typecheck, build, and em-dash sweep pass.

Before editing, briefly summarize the current implementation and propose the smallest solid architecture. Then implement it.
```
