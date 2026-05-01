# Dogfood 001: add CONTRIBUTING.md

A tiny docs-only plan for the first end-to-end dogfood run on the
ChoirMaster repository itself. Single new file at the repository root.
Zero source-code edits. Low blast radius.

## Goal

Create a brief `CONTRIBUTING.md` at the repository root that tells a new
contributor how to set up the project locally and verify their changes
before opening a pull request.

## Constraints

- Only `CONTRIBUTING.md` may be created or modified.
- Do not touch any other file in the repo, including `README.md`,
  `package.json`, anything under `packages/`, or any config file.
- Do not run `pnpm install`, `pnpm build`, `pnpm test`, or any other
  setup command yourself; the orchestrator runs gates after the turn.

## What CONTRIBUTING.md should contain

Keep it short. One screen of markdown. Plain prose, no badges, no
clever ASCII. Sections in this order:

1. **Title and one-line summary.** "Contributing to ChoirMaster" and a
   single sentence saying ChoirMaster is pre-alpha and accepts
   small-scope pull requests.
2. **Prerequisites.** Node 20 or newer, and pnpm 10 or newer.
3. **Setup.** A single command: `pnpm install`.
4. **Verification.** Three commands a contributor should run before
   opening a PR: `pnpm typecheck`, `pnpm test`, `pnpm build`.
5. **Commit conventions.** A single line: use conventional commit
   prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`) and keep
   the subject line under 70 characters.
6. **Pre-alpha caveat.** A single paragraph saying APIs may change
   without notice, please open an issue before doing significant work
   so it can be scoped, and that everything in `docs/roadmap.md`
   reflects current intent.

Each section should be a heading and a short paragraph or one bullet
list. No nested subsections.

## Definition of done

- `CONTRIBUTING.md` exists at the repository root.
- It contains all six sections listed above, in that order, each as
  its own `##` heading.
- The file is between 30 and 80 non-empty lines.
- It contains no em dash characters (use hyphens).
- `pnpm typecheck`, `pnpm test`, and `pnpm build` all still pass
  unchanged after this task lands.
