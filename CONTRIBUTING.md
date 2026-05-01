## Contributing to ChoirMaster

ChoirMaster is pre-alpha software that accepts small-scope, focused PRs
aligned with the current roadmap.

## Prerequisites

Before contributing, make sure you have the following installed:

- Node.js 20 or newer
- pnpm 10 or newer

## Setup

Clone the repository and install dependencies:

```sh
pnpm install
```

## Verification

Run all three of the following commands before opening a PR:

```sh
pnpm typecheck
pnpm test
pnpm build
```

All three must pass cleanly.

## Commit conventions

Prefix commit subjects with one of the following types:

- `feat:` - a new feature
- `fix:` - a bug fix
- `docs:` - documentation changes only
- `chore:` - maintenance, tooling, or config
- `refactor:` - code restructuring with no behavior change

Keep the subject line to 70 characters or fewer. Write the subject in the
imperative mood ("add X" not "adds X" or "added X").

## Pre-alpha caveat

APIs may change without notice as the project evolves. Before starting
significant work, please open an issue to discuss scope and approach - this
avoids wasted effort when direction shifts. See
[docs/roadmap.md](docs/roadmap.md) for current intent.
