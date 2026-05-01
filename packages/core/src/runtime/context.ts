/**
 * Per-run context. Bundles the project root, the run-local directories the
 * runtime writes to, and the resolved project config + runtime overrides.
 * Passed through the orchestration loop so individual functions don't have
 * to take a long argument list.
 */

import type { ProjectConfig, RuntimeOverrides } from '../types.js'

export interface RuntimeContext {
  /** Absolute path to the project root (the git repo). */
  projectRoot: string
  /** Absolute path to the run directory, e.g. `<repo>/.choirmaster/runs/<id>`. */
  runDir: string
  /** Absolute path to the logs directory inside the run. */
  logsDir: string
  /** The resolved project manifest (already loaded by the CLI). */
  config: ProjectConfig
  /** Active runtime overrides set via `choirmaster set ...`. */
  overrides?: RuntimeOverrides
}
