import { describe, expect, it } from 'vitest'

import { completionsCommand } from './completions.js'

describe('completionsCommand', () => {
  it('prints zsh completions backed by the internal completion command', () => {
    const { code, stdout } = capture(() => completionsCommand({ shell: 'zsh' }))

    expect(code).toBe(0)
    expect(stdout).toContain('compdef _choirmaster choirmaster')
    expect(stdout).toContain('__complete markdown "$cur"')
    expect(stdout).toContain('powershell pwsh nushell nu')
  })

  it('prints bash completions backed by the internal completion command', () => {
    const { code, stdout } = capture(() => completionsCommand({ shell: 'bash' }))

    expect(code).toBe(0)
    expect(stdout).toContain('complete -F _choirmaster_completion cm')
    expect(stdout).toContain('__complete markdown "$cur"')
  })

  it('prints fish completions backed by the internal completion command', () => {
    const { code, stdout } = capture(() => completionsCommand({ shell: 'fish' }))

    expect(code).toBe(0)
    expect(stdout).toContain('function __choirmaster_complete_markdown')
    expect(stdout).toContain('__complete markdown $token')
  })

  it('prints PowerShell completions', () => {
    const { code, stdout } = capture(() => completionsCommand({ shell: 'powershell' }))

    expect(code).toBe(0)
    expect(stdout).toContain('Register-ArgumentCompleter')
    expect(stdout).toContain('__complete markdown $wordToComplete')
  })

  it('accepts pwsh as a PowerShell alias', () => {
    const { code, stdout } = capture(() => completionsCommand({ shell: 'pwsh' }))

    expect(code).toBe(0)
    expect(stdout).toContain('Register-ArgumentCompleter')
  })

  it('normalizes shell names case-insensitively', () => {
    const { code, stdout } = capture(() => completionsCommand({ shell: 'PowerShell' }))

    expect(code).toBe(0)
    expect(stdout).toContain('Register-ArgumentCompleter')
  })

  it('prints Nushell completions', () => {
    const { code, stdout } = capture(() => completionsCommand({ shell: 'nushell' }))

    expect(code).toBe(0)
    expect(stdout).toContain('extern "choirmaster plan"')
    expect(stdout).toContain('__complete markdown $token')
    expect(stdout).toContain('^$bin __complete markdown $token')
  })

  it('accepts nu as a Nushell alias', () => {
    const { code, stdout } = capture(() => completionsCommand({ shell: 'nu' }))

    expect(code).toBe(0)
    expect(stdout).toContain('extern "cm run"')
  })

  it('prints usage for unknown shells', () => {
    const { code, stderr } = capture(() => completionsCommand({ shell: 'tcsh' }))

    expect(code).toBe(64)
    expect(stderr).toContain('Usage: choirmaster completions <zsh|bash|fish|powershell|nushell>')
  })
})

function capture(fn: () => number): { code: number; stdout: string; stderr: string } {
  let stdout = ''
  let stderr = ''
  const originalStdout = process.stdout.write
  const originalStderr = process.stderr.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString()
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString()
    return true
  }) as typeof process.stderr.write
  try {
    return { code: fn(), stdout, stderr }
  }
  finally {
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
  }
}
