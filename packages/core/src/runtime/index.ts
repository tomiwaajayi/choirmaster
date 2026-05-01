/**
 * Runtime utilities. Project-agnostic primitives that the orchestration loop
 * (and any user-built loop) depends on. Imported via `@choirmaster/core/runtime`
 * once subpath exports are wired; for now re-exported through the top-level
 * package barrel.
 */

export * from './git.js'
export * from './log.js'
export * from './state.js'
export * from './scope.js'
export * from './gates.js'
export * from './handoff.js'
export * from './context.js'
export * from './commit.js'
export * from './prompt.js'
export * from './loop.js'
