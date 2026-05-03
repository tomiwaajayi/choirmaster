import { describe, expect, it } from 'vitest'

import { findShellCommand, listShellCommandNames, SHELL_COMMANDS } from './commands.js'

describe('shell command registry', () => {
  it('exposes every documented command', () => {
    expect(listShellCommandNames()).toEqual([
      '/draft',
      '/plan',
      '/run',
      '/resume',
      '/doctor',
      '/help',
      '/exit',
    ])
  })

  it('routes /run to the run cli command', () => {
    const run = findShellCommand('/run')!
    expect(run.toCliArgs?.(['@example'])).toEqual(['run', '@example'])
  })

  it('routes /resume with no args to null so the shell can open the picker', () => {
    const resume = findShellCommand('/resume')!
    expect(resume.toCliArgs?.([])).toBeNull()
    expect(resume.toCliArgs?.(['abc'])).toEqual(['--resume', 'abc'])
  })

  it('treats /quit as an alias for /exit', () => {
    expect(findShellCommand('/quit')).toBe(findShellCommand('/exit'))
  })

  it('returns undefined for unknown commands', () => {
    expect(findShellCommand('/nope')).toBeUndefined()
  })

  it('keeps every visible command in SHELL_COMMANDS', () => {
    for (const name of listShellCommandNames()) {
      expect(SHELL_COMMANDS.find((cmd) => cmd.name === name)).toBeTruthy()
    }
  })
})
