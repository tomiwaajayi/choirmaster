/**
 * Copy the root README and LICENSE into packages/cli/ so the published
 * tarball ships them. Runs as `prepack` so npm pack / pnpm publish always
 * picks up the latest version from the repo root, and the per-package
 * copies stay gitignored to prevent drift.
 */

import { copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgDir = join(here, '..')
const repoRoot = join(pkgDir, '..', '..')

const files = ['README.md', 'LICENSE']
for (const name of files) {
  copyFileSync(join(repoRoot, name), join(pkgDir, name))
  // Write progress to stderr so `npm pack --silent` stdout stays clean for
  // automation shaped like `TARBALL=$(npm pack --silent ...)`.
  process.stderr.write(`synced ${name}\n`)
}
