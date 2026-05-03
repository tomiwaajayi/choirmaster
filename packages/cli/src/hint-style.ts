/**
 * "Next: ..." hints adapt to where the user is.
 *
 * Inside the interactive shell (`cm`), we want to point at slash
 * commands the user can type right there. From a plain terminal, we
 * point at the top-level CLI form.
 *
 * The shell sets `_CHOIRMASTER_INTERACTIVE=1` for its lifetime via
 * `pushInteractiveHintScope()`; downstream commands check that variable
 * and pick the matching form. The leading underscore signals "private
 * to ChoirMaster" so subprocesses (gates, agents, sandbox prepare hooks)
 * inherit it without naming-collision worries.
 *
 * SIGINT is the one case where we always print the outside form: the
 * run-time SIGINT handler kills the process (and the shell), so the
 * user is starting fresh and `cm --resume <id>` is the right next step.
 */

const ENV_VAR = '_CHOIRMASTER_INTERACTIVE'

export interface HintStyle {
  /** Resume command for unfinished runs in `printSummary`-style output. */
  resume: (runId: string) => string
  /** Run command shown after `/draft` and `/plan` to point at the next step. */
  runReference: (reference: string) => string
}

const SHELL_STYLE: HintStyle = {
  resume: (runId) => `/resume ${runId}`,
  runReference: (reference) => `/run ${reference}`,
}

const CLI_STYLE: HintStyle = {
  resume: (runId) => `cm --resume ${runId}`,
  runReference: (reference) => `choirmaster run ${reference}`,
}

export function isShellHintStyle(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_VAR] === '1'
}

export function hintStyle(env: NodeJS.ProcessEnv = process.env): HintStyle {
  return isShellHintStyle(env) ? SHELL_STYLE : CLI_STYLE
}

/**
 * Stack-based env management so nested or overlapping shell scopes
 * (theoretical, but cheap to defend against) restore correctly.
 *
 * Caller pattern:
 *   const release = pushInteractiveHintScope()
 *   try { ... } finally { release() }
 *
 * The first push records whatever the env was; later pushes are no-ops
 * for the env value but bump the depth. The final release restores the
 * original value.
 */
let depth = 0
let savedValue: string | undefined

export function pushInteractiveHintScope(): () => void {
  if (depth === 0) {
    savedValue = process.env[ENV_VAR]
    process.env[ENV_VAR] = '1'
  }
  depth += 1
  let released = false
  return () => {
    if (released) return
    released = true
    depth -= 1
    if (depth === 0) {
      if (savedValue === undefined) delete process.env[ENV_VAR]
      else process.env[ENV_VAR] = savedValue
      savedValue = undefined
    }
  }
}

export const INTERACTIVE_ENV_VAR = ENV_VAR

/**
 * Test-only: drop any in-flight scope state. Production callers always
 * pair `pushInteractiveHintScope()` with its returned release in a
 * try/finally, so depth never leaks. Tests that simulate aborted scopes
 * (or that share a vitest worker with other suites) should call this
 * in their teardown to keep the module-level depth/savedValue from
 * carrying poisoned state into the next test.
 */
export function resetHintScopeForTests(): void {
  depth = 0
  savedValue = undefined
  delete process.env[ENV_VAR]
}
