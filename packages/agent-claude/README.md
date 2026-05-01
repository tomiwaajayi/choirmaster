# @choirmaster/agent-claude

Claude Code agent for [ChoirMaster](https://github.com/tomiwaajayi/choirmaster). Wraps `claude -p` with streaming tool-call visibility and capacity-aware error handling.

## Install

```bash
npm install @choirmaster/agent-claude
```

You also need the official Claude Code CLI installed and authenticated on your machine. ChoirMaster shells out to it; we don't bundle credentials, store sessions, or talk to Anthropic directly.

## Usage

```ts
import { claude, claudeFactory } from '@choirmaster/agent-claude'
import { defineProject } from '@choirmaster/core'

export default defineProject({
  base: 'main',
  agents: {
    planner: claude('opus'),
    implementer: claude('sonnet', { effort: 'high' }),
    reviewer: claude('opus'),
  },
  // ...
})
```

The `claudeFactory` value lets the runtime resolve `claude:opus` strings (e.g. from `choirmaster set-model implementer claude:opus`) into fresh agents without editing the manifest.

## Options

| Option | Default | Notes |
|---|---|---|
| `effort` | unset | `low` / `medium` / `high` / `max`, where supported |
| `timeoutMs` | unset | Per-turn timeout. SIGTERM on expiry. |
| `bin` | `"claude"` | Path to the binary if it's not on PATH |
| `permissionMode` | `"bypassPermissions"` | Matches what the runtime expects; the orchestrator enforces scope post-edit |

## License

MIT
