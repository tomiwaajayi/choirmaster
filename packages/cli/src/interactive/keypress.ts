/**
 * Idempotent wrapper around Node's emitKeypressEvents.
 *
 * Node's stdlib already guards against double-installing the keypress
 * decoder, but it does so via an undocumented `_keypressDecoder`
 * property. Reading the public-API marker we install ourselves keeps
 * the contract local to ChoirMaster's code.
 */

import { emitKeypressEvents } from 'node:readline'
import type { ReadStream } from 'node:tty'

const KEYPRESS_INSTALLED = Symbol.for('choirmaster.keypressInstalled')

interface MaybeMarked extends ReadStream {
  [KEYPRESS_INSTALLED]?: boolean
}

export function ensureKeypressEvents(input: ReadStream): void {
  const marked = input as MaybeMarked
  if (marked[KEYPRESS_INSTALLED]) return
  emitKeypressEvents(input)
  marked[KEYPRESS_INSTALLED] = true
}
