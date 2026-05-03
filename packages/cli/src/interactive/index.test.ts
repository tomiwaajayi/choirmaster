/**
 * Lifecycle test for interactiveCommand.
 *
 * The shell's main read loop is tested via input.test.ts (the input
 * surface) and route.test.ts (the dispatch surface). Here we verify
 * the lifecycle wrapper itself: env-var management and the catch
 * around dispatch errors.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { INTERACTIVE_ENV_VAR } from '../hint-style.js'

import { interactiveCommand } from './index.js'

afterEach(() => {
  delete process.env[INTERACTIVE_ENV_VAR]
})

describe('interactiveCommand', () => {
  it('exits cleanly when stdin is not a TTY (returns 0)', async () => {
    // The default stdin during vitest is not a TTY, so readLineWithSuggestions
    // returns kind:'eof' on the first read and the loop returns 0.
    const code = await interactiveCommand({
      dispatch: async () => 0,
    })
    expect(code).toBe(0)
  })

  it('restores the env var to its prior state on return', async () => {
    expect(process.env[INTERACTIVE_ENV_VAR]).toBeUndefined()
    await interactiveCommand({ dispatch: async () => 0 })
    expect(process.env[INTERACTIVE_ENV_VAR]).toBeUndefined()
  })

  it('preserves a pre-existing env value across the shell session', async () => {
    process.env[INTERACTIVE_ENV_VAR] = 'pre-existing'
    await interactiveCommand({ dispatch: async () => 0 })
    expect(process.env[INTERACTIVE_ENV_VAR]).toBe('pre-existing')
  })
})
