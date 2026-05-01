/**
 * Stream-json parser for Claude Code's headless mode.
 *
 * `claude -p --output-format stream-json --verbose` emits one JSON event per
 * line. We translate each event into zero or more canonical `AgentEvent`
 * values so the runtime's logger and CLI display don't have to know about
 * Claude's internal protocol. Unknown event shapes are dropped silently;
 * the raw line is still in the log file as a fallback transcript.
 */

import type { AgentEvent } from '@choirmaster/core'

interface JsonObject {
  [key: string]: unknown
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseStreamLine(line: string): AgentEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let event: unknown
  try {
    event = JSON.parse(trimmed)
  }
  catch {
    return []
  }
  if (!isObject(event)) return []

  const events: AgentEvent[] = []
  const type = event['type']

  if (type === 'assistant') {
    const message = event['message']
    if (isObject(message)) {
      const content = message['content']
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isObject(block)) continue
          const blockType = block['type']
          if (blockType === 'text' && typeof block['text'] === 'string') {
            events.push({ kind: 'text', text: block['text'] })
          }
          else if (blockType === 'thinking') {
            const text = typeof block['thinking'] === 'string'
              ? block['thinking']
              : typeof block['text'] === 'string' ? block['text'] : ''
            events.push({ kind: 'thinking', text })
          }
          else if (blockType === 'tool_use') {
            const name = typeof block['name'] === 'string' ? block['name'] : 'tool'
            const input = isObject(block['input']) ? (block['input'] as Record<string, unknown>) : {}
            events.push({ kind: 'tool_use', name, input })
          }
        }
      }
    }
  }
  else if (type === 'user') {
    const message = event['message']
    if (isObject(message)) {
      const content = message['content']
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isObject(block) || block['type'] !== 'tool_result') continue
          const isError = block['is_error'] === true
          events.push({
            kind: 'tool_result',
            ok: !isError,
            snippet: extractSnippet(block),
          })
        }
      }
    }
  }
  else if (type === 'result') {
    if (event['is_error'] === true || event['subtype'] === 'error_during_execution') {
      const message = typeof event['error'] === 'string'
        ? event['error']
        : typeof event['subtype'] === 'string' ? event['subtype'] : 'error'
      events.push({ kind: 'error', message })
    }
  }

  return events
}

function extractSnippet(block: JsonObject): string | undefined {
  const content = block['content']
  if (typeof content === 'string') return content.slice(0, 200)
  if (Array.isArray(content)) {
    const text = content
      .map((entry) => {
        if (isObject(entry) && typeof entry['text'] === 'string') return entry['text']
        return ''
      })
      .filter(Boolean)
      .join(' ')
    return text ? text.slice(0, 200) : undefined
  }
  return undefined
}

/**
 * Pretty-print an AgentEvent for terminal display. Returns null for events
 * the user shouldn't see in the live log (e.g. internal thinking, success
 * tool_results - the next assistant turn shows what's happening).
 */
export function prettyEvent(event: AgentEvent): string | null {
  switch (event.kind) {
    case 'text':
      return event.text
    case 'tool_use':
      return formatToolUse(event.name, event.input)
    case 'tool_result':
      return event.ok ? null : `  ${event.snippet ? '✗ ' + event.snippet : '✗'}`
    case 'thinking':
      return null
    case 'error':
      return `[error] ${event.message}`
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

function formatToolUse(name: string, input: Record<string, unknown>): string {
  const file = typeof input['file_path'] === 'string' ? input['file_path'] : undefined
  const command = typeof input['command'] === 'string' ? input['command'] : undefined
  const pattern = typeof input['pattern'] === 'string' ? input['pattern'] : undefined
  const path = typeof input['path'] === 'string' ? input['path'] : undefined

  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `  → ${name}${file ? ` ${file}` : ''}`
    case 'Read':
      return `  → Read${file ? ` ${file}` : ''}`
    case 'Bash':
      return `  → Bash: ${(command ?? '').slice(0, 100)}`
    case 'Grep':
      return `  → Grep "${pattern ?? ''}"${path ? ` in ${path}` : ''}`
    case 'Glob':
      return `  → Glob ${pattern ?? ''}`
    default:
      return `  → ${name}`
  }
}
