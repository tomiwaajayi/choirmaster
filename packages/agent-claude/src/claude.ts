/**
 * Claude Code agent. Wraps `claude -p --output-format stream-json --verbose`
 * with the canonical Agent surface: streaming events, structured result,
 * capacity-error detection.
 *
 * The factory function `claude(model, opts)` returns a fresh Agent with the
 * requested model baked in. The `claudeFactory` value lets the runtime
 * resolve `claude:opus` strings into agents at run time.
 */

import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

import type {
  Agent,
  AgentEvent,
  AgentFactory,
  AgentFactoryOptions,
  AgentInvokeOpts,
  AgentResult,
} from '@choirmaster/core'

import { detectCapacityError } from './capacity.js'
import { parseStreamLine } from './parser.js'

export interface ClaudeOptions extends AgentFactoryOptions {
  /** Path to the `claude` binary. Defaults to "claude" (looked up on PATH). */
  bin?: string
  /**
   * Permission mode passed to `claude -p`. Defaults to "bypassPermissions"
   * because the runtime already enforces scope via post-edit checks; the CLI
   * permission layer is redundant friction in unattended runs.
   */
  permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'plan' | 'default'
}

const DEFAULT_OPTIONS: Required<Pick<ClaudeOptions, 'bin' | 'permissionMode'>> = {
  bin: 'claude',
  permissionMode: 'bypassPermissions',
}

/**
 * Construct a Claude Code agent for the given model.
 *
 * @example
 *   import { claude } from '@choirmaster/agent-claude'
 *   const implementer = claude('sonnet', { effort: 'high' })
 */
export function claude(model: string, options: ClaudeOptions = {}): Agent {
  const merged: ClaudeOptions = { ...DEFAULT_OPTIONS, ...options }
  return {
    name: `claude:${model}`,
    engine: 'claude',
    model,
    invoke: (opts, onEvent) => invokeClaude(model, merged, opts, onEvent),
  }
}

/**
 * AgentFactory entry. Register at runtime so `choirmaster set-model
 * implementer claude:opus` resolves into a fresh agent without edits to
 * the manifest.
 */
export const claudeFactory: AgentFactory = {
  engine: 'claude',
  create(model: string, options?: AgentFactoryOptions): Agent {
    return claude(model, options as ClaudeOptions | undefined)
  },
}

async function invokeClaude(
  model: string,
  options: ClaudeOptions,
  opts: AgentInvokeOpts,
  onEvent?: (event: AgentEvent) => void,
): Promise<AgentResult> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const fullPrompt = [
      '# Operating context',
      opts.systemPrompt,
      '',
      '---',
      '',
      '# Task brief',
      opts.userPrompt,
    ].join('\n')

    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--model', model,
      '--permission-mode', options.permissionMode ?? 'bypassPermissions',
    ]
    if (options.effort) args.push('--effort', options.effort)
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowed-tools', opts.allowedTools.join(','))
    }

    const child = spawn(options.bin ?? 'claude', args, {
      cwd: opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let stdoutBuffer = ''

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')

    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk
      stdoutBuffer += chunk
      const lines = stdoutBuffer.split('\n')
      stdoutBuffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const events = parseStreamLine(line)
        if (onEvent) {
          for (const event of events) onEvent(event)
        }
      }
    })

    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
    })

    let timeoutHandle: NodeJS.Timeout | undefined
    if (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) {
      timeoutHandle = setTimeout(() => {
        child.kill('SIGTERM')
      }, opts.timeoutMs)
    }

    const finish = (status: number | null, extraStderr = '') => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      // Flush any partial line still in the buffer.
      if (stdoutBuffer.trim()) {
        const events = parseStreamLine(stdoutBuffer)
        if (onEvent) for (const event of events) onEvent(event)
      }
      const finalStderr = stderr + extraStderr
      const capacity = detectCapacityError({ exitStatus: status, stderr: finalStderr })
      resolve({
        status,
        stdout,
        stderr: finalStderr,
        durationMs: Math.round(performance.now() - t0),
        capacityHit: capacity.hit,
        capacitySignal: capacity.signal,
      })
    }

    child.on('close', (code) => finish(code))
    child.on('error', (err) => finish(null, `\n[spawn error] ${err.message}`))

    child.stdin?.write(fullPrompt)
    child.stdin?.end()
  })
}
