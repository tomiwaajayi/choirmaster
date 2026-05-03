/**
 * Re-export barrel kept for legacy import paths.
 *
 * The shell implementation lives in `./interactive/`; new code should
 * import from there directly. These re-exports are preserved so
 * external integrators and the existing `interactive.test.ts` keep
 * working without churn.
 */

export {
  completeInteractiveLine,
  interactiveCommand,
  parseInteractiveLine,
} from './interactive/index.js'
export type { InteractiveCommandArgs } from './interactive/index.js'
