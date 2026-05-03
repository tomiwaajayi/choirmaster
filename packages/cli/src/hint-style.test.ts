import { afterEach, describe, expect, it } from 'vitest'

import {
  hintStyle,
  INTERACTIVE_ENV_VAR,
  isShellHintStyle,
  pushInteractiveHintScope,
} from './hint-style.js'

afterEach(() => {
  // Defensive: tests below mutate process.env. Make sure the global
  // env is clean so other suites don't pick up leaked state.
  delete process.env[INTERACTIVE_ENV_VAR]
})

describe('hintStyle', () => {
  it('returns CLI form when the env var is unset', () => {
    const env = {} as NodeJS.ProcessEnv
    expect(isShellHintStyle(env)).toBe(false)
    const style = hintStyle(env)
    expect(style.resume('abc')).toBe('cm --resume abc')
    expect(style.runReference('@example')).toBe('choirmaster run @example')
  })

  it('returns shell form when the env var is "1"', () => {
    const env = { [INTERACTIVE_ENV_VAR]: '1' } as NodeJS.ProcessEnv
    expect(isShellHintStyle(env)).toBe(true)
    const style = hintStyle(env)
    expect(style.resume('abc')).toBe('/resume abc')
    expect(style.runReference('@example')).toBe('/run @example')
  })

  it('treats values other than "1" as not interactive', () => {
    const env = { [INTERACTIVE_ENV_VAR]: 'true' } as NodeJS.ProcessEnv
    expect(isShellHintStyle(env)).toBe(false)
  })

  it('uses an underscore-prefixed env var name to signal "private to ChoirMaster"', () => {
    expect(INTERACTIVE_ENV_VAR.startsWith('_')).toBe(true)
  })
})

describe('pushInteractiveHintScope', () => {
  it('sets the env var while the scope is active and restores on release', () => {
    expect(process.env[INTERACTIVE_ENV_VAR]).toBeUndefined()
    const release = pushInteractiveHintScope()
    expect(process.env[INTERACTIVE_ENV_VAR]).toBe('1')
    release()
    expect(process.env[INTERACTIVE_ENV_VAR]).toBeUndefined()
  })

  it('preserves a pre-existing value across the scope', () => {
    process.env[INTERACTIVE_ENV_VAR] = 'custom'
    const release = pushInteractiveHintScope()
    expect(process.env[INTERACTIVE_ENV_VAR]).toBe('1')
    release()
    expect(process.env[INTERACTIVE_ENV_VAR]).toBe('custom')
  })

  it('nests safely: outer scope only restores after every inner release', () => {
    expect(process.env[INTERACTIVE_ENV_VAR]).toBeUndefined()
    const releaseOuter = pushInteractiveHintScope()
    const releaseInner = pushInteractiveHintScope()
    expect(process.env[INTERACTIVE_ENV_VAR]).toBe('1')
    releaseInner()
    // Outer scope still holds the env var.
    expect(process.env[INTERACTIVE_ENV_VAR]).toBe('1')
    releaseOuter()
    expect(process.env[INTERACTIVE_ENV_VAR]).toBeUndefined()
  })

  it('release is idempotent', () => {
    const release = pushInteractiveHintScope()
    release()
    release() // should not double-decrement and pop a phantom scope
    expect(process.env[INTERACTIVE_ENV_VAR]).toBeUndefined()
  })
})
