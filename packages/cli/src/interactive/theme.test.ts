import { afterEach, describe, expect, it } from 'vitest'

import { makeTheme } from './theme.js'

const previousNoColor = process.env.NO_COLOR

afterEach(() => {
  if (previousNoColor === undefined) delete process.env.NO_COLOR
  else process.env.NO_COLOR = previousNoColor
})

describe('makeTheme', () => {
  it('returns identity functions for non-TTY output', () => {
    const fakeStdout = { isTTY: false } as unknown as NodeJS.WriteStream
    const theme = makeTheme(fakeStdout)
    expect(theme.bold('x')).toBe('x')
    expect(theme.dim('x')).toBe('x')
    expect(theme.cyan('x')).toBe('x')
    expect(theme.green('x')).toBe('x')
    expect(theme.yellow('x')).toBe('x')
    expect(theme.red('x')).toBe('x')
  })

  it('returns identity functions when NO_COLOR is set, even on a TTY', () => {
    process.env.NO_COLOR = '1'
    const fakeStdout = { isTTY: true } as unknown as NodeJS.WriteStream
    const theme = makeTheme(fakeStdout)
    expect(theme.cyan('x')).toBe('x')
  })

  it('wraps colors with ANSI sequences on a TTY when NO_COLOR is unset', () => {
    delete process.env.NO_COLOR
    const fakeStdout = { isTTY: true } as unknown as NodeJS.WriteStream
    const theme = makeTheme(fakeStdout)
    expect(theme.green('ok')).toBe('\x1b[32mok\x1b[39m')
    expect(theme.red('err')).toBe('\x1b[31merr\x1b[39m')
    expect(theme.yellow('warn')).toBe('\x1b[33mwarn\x1b[39m')
    expect(theme.cyan('hi')).toBe('\x1b[36mhi\x1b[39m')
    expect(theme.bold('big')).toBe('\x1b[1mbig\x1b[22m')
    expect(theme.dim('quiet')).toBe('\x1b[2mquiet\x1b[22m')
  })
})
