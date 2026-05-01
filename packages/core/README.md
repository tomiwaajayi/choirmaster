# @choirmaster/core

Type contracts and runtime substrate for [ChoirMaster](https://github.com/tomiwaajayi/choirmaster).

This package defines the shapes that flow between the planner, the runtime, and user-authored project config. Other ChoirMaster packages implement the interfaces here.

## Status

Pre-alpha. Types are stable surface; runtime mechanics land in upcoming releases.

## What's exported

- `Task`, `RunState`, `Handoff`, `Review`, `ReviewIssue` - contract shapes
- `Agent`, `AgentInvokeOpts`, `AgentResult`, `AgentEvent` - the agent interface (Claude, Codex, ... implement this)
- `Sandbox`, `SandboxHandle` - the workspace interface (worktree, docker, ...)
- `BranchPolicy`, `MergeOutcome` - how completed tasks rejoin the base branch
- `GateConfig`, `GateResult` - deterministic check shapes
- `ProjectConfig`, `defineProject(config)` - typed project manifest helper

## License

MIT
