/**
 * The orchestration loop. Drives one task end-to-end: implementer attempt
 * loop with retries, scope check, deterministic gates, reviewer loop with
 * iteration cap, final-verify pass, commit + branch policy.
 *
 * Resilience features:
 *   - Capacity-aware pause: if the agent's CLI hits a usage limit, the
 *     task is saved as `waiting_for_capacity` with `paused_phase` set so a
 *     subsequent run can resume routing into the right phase.
 *   - Phase-aware resume: routes back into reviewer or implementer-fix
 *     instead of restarting the implementer when the loop already passed
 *     that point.
 *   - Final-verify pass: after the reviewer iteration cap is exhausted,
 *     one extra reviewer call is made on the final fix's diff so a
 *     trivial last-iteration finding (already addressed by the
 *     implementer fix) doesn't falsely block the task.
 *   - Commit-time scope re-check + worktree revert on violation.
 *
 * The loop is project-agnostic: it consumes RuntimeContext and the
 * pluggable Agent / Sandbox / BranchPolicy interfaces.
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type {
  AgentEvent,
  CompletionOutcome,
  Handoff,
  Review,
  RunState,
  SandboxHandle,
  Task,
} from '../types.js'

import { commitWorktree } from './commit.js'
import type { RuntimeContext } from './context.js'
import { runGates, summariseFailures } from './gates.js'
import { captureFullDiff, currentBranch, getChangedFiles, revParse, revertWorktree } from './git.js'
import { readHandoff, readReview } from './handoff.js'
import { createTaskLogger, type TaskLogger } from './log.js'
import {
  buildImplementerUserPrompt,
  buildReviewerUserPrompt,
  buildSystemPrompt,
  loadPromptFile,
  type ImplementerMode,
} from './prompt.js'
import { effectiveScope, checkScope } from './scope.js'
import { saveState } from './state.js'

export interface RunTaskOptions {
  /** Allow reusing an existing worktree at task.worktree. Default false. */
  allowReuseWorktree?: boolean
  /** Skip the auto-merge step from the branch policy. Default false. */
  skipAutoMerge?: boolean
}

export type ReviewerOutcome = 'ready' | 'blocked' | 'paused'

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_MAX_REVIEW_ITERATIONS = 3
const DEFAULT_AGENT_TURN_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Tool allowlists passed to agent.invoke. Tighter than `bypassPermissions`
 * alone: even with bypass on, the underlying CLI rejects anything not in
 * this list. The implementer needs Read/Write/Edit/Glob/Grep + a bounded
 * Bash subset for inspection; the reviewer is read-only.
 */
const IMPLEMENTER_TOOLS = [
  'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git ls-files:*)',
  'Bash(grep:*)',
  'Bash(find:*)',
  'Bash(rg:*)',
  'Bash(cat:*)',
  'Bash(ls:*)',
  'Bash(wc:*)',
]

const REVIEWER_TOOLS = [
  'Read', 'Glob', 'Grep',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git ls-files:*)',
  'Bash(grep:*)',
  'Bash(rg:*)',
  'Bash(cat:*)',
  'Bash(ls:*)',
  'Bash(wc:*)',
  'Bash(git status:*)',
]

// ─────────────────────────────────────────────────────────────────────────────
// Limit resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Effective max-implementer-attempts for a task. Per-task override wins,
 * then manifest `limits.maxAttempts`, then the built-in default. Resolved
 * fresh at each use so a manifest edit takes effect on the next run for
 * tasks that didn't set their own value.
 */
export function resolveMaxAttempts(
  task: { max_attempts?: number },
  config: { limits?: { maxAttempts?: number } },
): number {
  return task.max_attempts
    ?? config.limits?.maxAttempts
    ?? DEFAULT_MAX_ATTEMPTS
}

/**
 * Effective max-reviewer-iterations for a task. Same fallback chain as
 * `resolveMaxAttempts`.
 */
export function resolveMaxReviewIterations(
  task: { max_review_iterations?: number },
  config: { limits?: { maxReviewIterations?: number } },
): number {
  return task.max_review_iterations
    ?? config.limits?.maxReviewIterations
    ?? DEFAULT_MAX_REVIEW_ITERATIONS
}

// ─────────────────────────────────────────────────────────────────────────────
// runTask
// ─────────────────────────────────────────────────────────────────────────────

export async function runTask(
  ctx: RuntimeContext,
  state: RunState,
  task: Task,
  options: RunTaskOptions = {},
): Promise<void> {
  // Snapshot pre-mutation state so resume routing sees the real prior phase,
  // not the in_progress flag we set below.
  const previousStatus = task.status
  const previousAttempts = task.attempts
  const previousReviewIterations = task.review_iterations
  const previousPausedPhase = task.paused_phase
  const previousLastSummary = task.last_summary ?? ''
  const previousLastReviewIssues = task.last_review_issues ?? ''

  const logger = createTaskLogger(ctx.logsDir, task.id)
  // Resolve effective limits without mutating task. Per-task overrides win,
  // then manifest limits, then the built-in defaults. This way a manifest
  // limit change picks up immediately for tasks that didn't set their own.
  const maxAttempts = resolveMaxAttempts(task, ctx.config)
  const maxReviewIterations = resolveMaxReviewIterations(task, ctx.config)

  task.status = 'in_progress'
  task.paused_phase = undefined
  state.current_task = task.id
  saveState(ctx.runDir, state)
  logger.block('TASK START', `${task.id} - ${task.title}\n${task.spec_section ?? ''}`)

  // ── Resolve base + sanity check root branch ───────────────────────────────
  // The runtime owns base resolution: read it from the manifest, refuse to
  // run if the project root has drifted off it. This prevents tasks from
  // silently forking from a feature branch when the manifest says `main`.
  const baseRef = ctx.config.base
  const baseSha = revParse(baseRef, ctx.projectRoot)
  if (!baseSha) {
    return blockTask(ctx, state, task, logger, `Cannot resolve base ref '${baseRef}' to a SHA. Is the branch checked out and up to date?`)
  }
  const rootBranch = currentBranch(ctx.projectRoot)
  if (rootBranch !== baseRef) {
    return blockTask(
      ctx,
      state,
      task,
      logger,
      `Project root is on '${rootBranch ?? '(detached HEAD)'}', expected '${baseRef}' (per manifest.base). Switch to ${baseRef} before running.`,
    )
  }
  task.base_ref = baseRef
  task.base_sha = baseSha
  saveState(ctx.runDir, state)

  let cwd: string
  let sandboxHandle: SandboxHandle
  try {
    // Auto-reuse the worktree on any kind of resume: capacity pause
    // (waiting_for_capacity) or killed mid-run (in_progress). In both
    // cases the worktree was created on a prior run and still has the
    // agent's edits. --reuse-worktree is the additional manual override.
    const isResume = previousStatus === 'waiting_for_capacity' || previousStatus === 'in_progress'
    const allowReuse = isResume || (options.allowReuseWorktree ?? false)
    sandboxHandle = await ctx.config.sandbox.setup(task, ctx.projectRoot, { allowReuse })
    cwd = sandboxHandle.cwd
    logger.line(`Sandbox ready at ${sandboxHandle.cwd} (base ${task.base_ref}@${task.base_sha?.slice(0, 8)})`)
  }
  catch (err) {
    return blockTask(ctx, state, task, logger, `sandbox.setup failed: ${(err as Error).message}`)
  }

  // ── Phase-aware resume routing ────────────────────────────────────────────
  // Re-enter the reviewer loop when:
  //   - explicit capacity pause set paused_phase to 'reviewer' or 'implementer_fix'
  //   - a kill left no paused_phase but review_iterations > 0 (we were past
  //     the implementer phase when the process died)
  const wasInReviewerPhase
    = previousPausedPhase === 'reviewer'
    || previousPausedPhase === 'implementer_fix'
    || previousReviewIterations > 0
  if (wasInReviewerPhase) {
    // Defensive re-check on kill resume.
    //
    // For paused_phase === 'reviewer' we KNOW gates passed (the reviewer
    // call only fires after post-fix gates), so trust the worktree.
    //
    // For paused_phase === 'implementer_fix' OR an undefined-paused_phase
    // kill, the fix call or post-fix gates may not have completed. Trusting
    // the worktree here would let the reviewer approve a diff that never
    // passed gates. Re-verify scope + gates against the current worktree
    // before re-entering the reviewer; block on either failure with a
    // clear "reset and retry" message.
    if (previousPausedPhase !== 'reviewer') {
      if (!task.base_sha) {
        return blockTask(ctx, state, task, logger, 'Resume re-check: task.base_sha missing.')
      }
      const changed = getChangedFiles(cwd, task.base_sha)
      const scope = effectiveScope(task, ctx.config.forbiddenPaths)
      const violations = checkScope({
        changedFiles: changed,
        allowedPaths: scope.allowed,
        forbiddenPaths: scope.forbidden,
      })
      if (violations.length > 0) {
        const summary = violations.map((v) => `  - [${v.kind}] ${v.file}`).join('\n')
        const fullDiff = captureFullDiff(cwd, task.base_sha)
        const diffPath = join(ctx.logsDir, `${task.id}.scope-violation-resume-recheck.diff`)
        writeFileSync(diffPath, fullDiff)
        logger.block('RESUME RE-CHECK SCOPE VIOLATION', `${summary}\n\nFull diff: ${diffPath}`)
        revertWorktree(cwd, task.base_sha)
        return blockTask(ctx, state, task, logger, `Resume scope re-check failed:\n${summary}`)
      }
      const gates = task.gates.length > 0 ? task.gates : ctx.config.gates
      const gateResult = runGates(gates, cwd)
      if (!gateResult.ok) {
        const summary = summariseFailures(gateResult.results)
        logger.block('RESUME RE-CHECK GATES FAILED', summary)
        return blockTask(
          ctx,
          state,
          task,
          logger,
          `Resume gate re-check failed. The previous run was killed before post-fix gates completed; the worktree state cannot be trusted for review. \`choirmaster reset\` (when shipped) or manual investigation needed.`,
        )
      }
    }

    const reason = previousPausedPhase
      ? `paused at ${previousPausedPhase}`
      : `killed mid-reviewer (review_iterations=${previousReviewIterations}); scope and gates re-verified`
    logger.block('RESUME', `${reason}. Re-entering reviewer at iteration ${previousReviewIterations + 1}.`)
    const review = await runReviewerLoop(
      ctx,
      state,
      task,
      cwd,
      previousLastSummary || `${task.title}`,
      previousLastReviewIssues,
      logger,
    )
    return handlePostReview(ctx, state, task, sandboxHandle, logger, review, previousLastSummary, options)
  }

  // ── Implementer attempt loop ──────────────────────────────────────────────
  let lastFailureSummary = ''
  let lastSummary = previousLastSummary

  // Resume from the next un-completed attempt. `completed_attempts` only
  // advances when an attempt ran a full cycle (impl call returned, handoff
  // processed, scope + gates evaluated). An interrupt - capacity pause or
  // kill - leaves it where it was, so a paused task on its final allowed
  // attempt resumes onto that same attempt rather than blocking past max.
  const previousCompleted = task.completed_attempts ?? 0
  const startAttempt = previousCompleted + 1
  if (startAttempt > maxAttempts) {
    return blockTask(
      ctx,
      state,
      task,
      logger,
      `Max attempts (${maxAttempts}) already exhausted before resume; reset the task to retry.`,
    )
  }

  for (let attempt = startAttempt; attempt <= maxAttempts; attempt++) {
    task.attempts = attempt
    saveState(ctx.runDir, state)

    // Mode reflects history: INITIAL when no prior attempt has completed
    // a full cycle (incl. resumed-from-killed-first-attempt), else
    // FIX_CHECK_FAILURES so the implementer knows to read the failure
    // context. previousCompleted is read once at runTask entry; within
    // the loop, completed_attempts increments after each cycle.
    const haveCompletedPriorAttempt = (task.completed_attempts ?? 0) > 0
    const mode: ImplementerMode = haveCompletedPriorAttempt
      ? 'FIX_CHECK_FAILURES'
      : 'INITIAL_IMPLEMENTATION'
    const extra = haveCompletedPriorAttempt
      ? `Previous attempt failed deterministic checks. Failure output:\n\n${lastFailureSummary || '(see logs)'}`
      : 'Implement the spec end-to-end; self-review your diff before writing the handoff file.'

    const claude = await invokeImplementer(ctx, task, cwd, mode, extra, attempt, logger)

    if (claude.capacityHit) {
      // Interrupt: don't mark this attempt as completed. Resume will
      // re-enter at the same attempt number with the same mode.
      return pauseForCapacity(ctx, state, task, logger, 'implementer', claude.capacitySignal ?? 'capacity hit', `attempt ${attempt}`)
    }

    // Helper: an attempt is "completed" only after the full cycle
    // (handoff processed + scope evaluated + gates evaluated). A kill
    // anywhere before this marker leaves the attempt as not-yet-spent
    // so resume gets to redo it. Any caller that decides to advance
    // past this attempt (continue/return) calls markAttemptCompleted
    // first.
    const markAttemptCompleted = (): void => {
      task.completed_attempts = attempt
      saveState(ctx.runDir, state)
    }

    const handoffResult = readHandoff(cwd, task.id)
    if (!handoffResult.data) {
      const why = handoffResult.reason ?? 'no handoff file written'
      logger.line(`Implementer attempt ${attempt}: ${why}. Treating as failed attempt.`)
      lastFailureSummary = `Handoff problem: ${why}`
      markAttemptCompleted()
      continue
    }
    const handoff = handoffResult.data
    lastSummary = handoff.summary_of_changes ?? handoff.notes ?? ''
    task.last_summary = lastSummary
    saveState(ctx.runDir, state)

    if (handoff.verdict === 'BLOCKED') {
      markAttemptCompleted()
      return blockTask(ctx, state, task, logger, `Implementer blocked: ${handoff.notes}`)
    }
    if (handoff.verdict === 'NEEDS_FIXES') {
      logger.line(`Implementer reported NEEDS_FIXES on attempt ${attempt}; routing back as a fresh attempt.`)
      lastFailureSummary = handoff.notes || 'Implementer self-flagged NEEDS_FIXES'
      markAttemptCompleted()
      continue
    }

    // Scope check
    if (!task.base_sha) {
      return blockTask(ctx, state, task, logger, 'task.base_sha missing; cannot scope check')
    }
    const changed = getChangedFiles(cwd, task.base_sha)
    const scope = effectiveScope(task, ctx.config.forbiddenPaths)
    const violations = checkScope({
      changedFiles: changed,
      allowedPaths: scope.allowed,
      forbiddenPaths: scope.forbidden,
    })
    if (violations.length > 0) {
      const summary = violations.map((v) => `  - [${v.kind}] ${v.file}`).join('\n')
      const fullDiff = captureFullDiff(cwd, task.base_sha)
      const diffPath = join(ctx.logsDir, `${task.id}.scope-violation-attempt-${attempt}.diff`)
      writeFileSync(diffPath, fullDiff)
      logger.block(`SCOPE VIOLATION (attempt ${attempt})`, `${summary}\n\nFull diff: ${diffPath}`)
      revertWorktree(cwd, task.base_sha)
      lastFailureSummary = `Scope violations:\n${summary}\nWorktree reverted. Stay strictly within allowed_paths and never edit forbidden_paths.`
      markAttemptCompleted()
      continue
    }

    // Deterministic gates
    const gates = task.gates.length > 0 ? task.gates : ctx.config.gates
    const gateResult = runGates(gates, cwd)
    if (!gateResult.ok) {
      const failureSummary = summariseFailures(gateResult.results)
      logger.block(`GATES FAILED (attempt ${attempt})`, failureSummary)
      lastFailureSummary = failureSummary
      markAttemptCompleted()
      continue
    }

    // All green. Cycle complete; mark and move to reviewer.
    markAttemptCompleted()
    logger.block(`GATES PASSED (attempt ${attempt})`, 'All deterministic checks green.')
    // Fresh reviewer phase for this attempt - reset both started and
    // completed iter counters so resume into reviewer for THIS attempt
    // doesn't see stale values from a prior failed attempt.
    task.review_iterations = 0
    task.completed_review_iterations = 0
    saveState(ctx.runDir, state)
    const review = await runReviewerLoop(ctx, state, task, cwd, lastSummary, '', logger)
    return handlePostReview(ctx, state, task, sandboxHandle, logger, review, lastSummary, options)
  }

  return blockTask(
    ctx,
    state,
    task,
    logger,
    `Max implementation attempts (${maxAttempts}) exhausted - checks never went green.`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// runReviewerLoop
// ─────────────────────────────────────────────────────────────────────────────

export async function runReviewerLoop(
  ctx: RuntimeContext,
  state: RunState,
  task: Task,
  cwd: string,
  implementerSummary: string,
  previousLastReviewIssues: string,
  logger: TaskLogger,
): Promise<ReviewerOutcome> {
  const maxReviewIterations = resolveMaxReviewIterations(task, ctx.config)
  // Resume from the next un-completed iter. `completed_review_iterations`
  // only advances at terminal points (cycle done); an interrupt mid-iter
  // leaves it where it was so the same iter is redone, not skipped.
  // When this equals max, the for loop is naturally skipped and we fall
  // through to final-verify - which itself is idempotent on resume (a
  // capacity pause during the final-verify call leaves the same state,
  // and re-running it is what we want).
  const previousCompletedIters = task.completed_review_iterations ?? 0
  const startIter = previousCompletedIters + 1

  let lastReviewIssues = previousLastReviewIssues
  let runningSummary = implementerSummary

  for (let iter = startIter; iter <= maxReviewIterations; iter++) {
    task.review_iterations = iter
    saveState(ctx.runDir, state)

    // Helper: a reviewer iteration is "completed" only at a terminal
    // exit point (continue or fall-through-to-next-iter). An interrupt
    // anywhere before this marker leaves the iter unspent on resume.
    const markIterCompleted = (): void => {
      task.completed_review_iterations = iter
      saveState(ctx.runDir, state)
    }

    const reviewerRun = await invokeReviewer(ctx, task, cwd, runningSummary, iter, logger)
    if (reviewerRun.capacityHit) {
      pauseForCapacity(ctx, state, task, logger, 'reviewer', reviewerRun.capacitySignal ?? 'capacity hit', `iter ${iter}`)
      return 'paused'
    }

    const reviewResult = readReview(cwd, task.id)
    if (!reviewResult.data) {
      const why = reviewResult.reason ?? 'no review file written'
      logger.line(`Reviewer iter ${iter}: ${why}. Treating as BLOCKED.`)
      markIterCompleted()
      continue
    }
    const review = reviewResult.data
    // Strict-mode invariant from the reviewer prompt: READY only when the
    // issues array is empty. A contradictory verdict (READY with populated
    // issues) is treated as BLOCKED so the issues get back to the
    // implementer and the contract isn't silently violated.
    if (review.verdict === 'READY' && review.issues.length === 0) {
      logger.block(`REVIEWER READY (iter ${iter})`, review.notes || 'No notes.')
      return 'ready'
    }
    if (review.verdict === 'READY' && review.issues.length > 0) {
      logger.line(`Reviewer iter ${iter} returned READY with ${review.issues.length} issue(s); strict mode treats this as BLOCKED.`)
    }

    // BLOCKED (or contradictory READY) -> feed issues to implementer fix
    lastReviewIssues = review.issues
      .map((i, idx) => `  ${idx + 1}. [${i.severity}] ${i.axis} · ${i.file}${i.line ? `:${i.line}` : ''} - ${i.description}`)
      .join('\n')
    task.last_review_issues = lastReviewIssues
    saveState(ctx.runDir, state)
    logger.block(`REVIEWER BLOCKED (iter ${iter})`, lastReviewIssues)

    const fixRun = await invokeImplementer(
      ctx,
      task,
      cwd,
      'FIX_REVIEW_FINDINGS',
      `Reviewer issues:\n${lastReviewIssues}`,
      iter,
      logger,
      `implementer fix iter ${iter}`,
    )
    if (fixRun.capacityHit) {
      pauseForCapacity(ctx, state, task, logger, 'implementer_fix', fixRun.capacitySignal ?? 'capacity hit', `fix iter ${iter}`)
      return 'paused'
    }

    const fixResult = readHandoff(cwd, task.id)
    if (!fixResult.data) {
      const why = fixResult.reason ?? 'no handoff file written'
      logger.line(`Implementer fix iter ${iter}: ${why}. Will retry next iter.`)
      markIterCompleted()
      continue
    }
    const fixHandoff = fixResult.data
    if (fixHandoff.verdict === 'BLOCKED') {
      task.blocked_reason = `Implementer pushed back on review: ${fixHandoff.notes}`
      return 'blocked'
    }
    runningSummary = fixHandoff.summary_of_changes ?? fixHandoff.notes ?? runningSummary
    task.last_summary = runningSummary
    saveState(ctx.runDir, state)

    // Re-verify scope and gates after the fix.
    if (!task.base_sha) {
      task.blocked_reason = 'task.base_sha missing during reviewer fix'
      return 'blocked'
    }
    const changed = getChangedFiles(cwd, task.base_sha)
    const scope = effectiveScope(task, ctx.config.forbiddenPaths)
    const violations = checkScope({
      changedFiles: changed,
      allowedPaths: scope.allowed,
      forbiddenPaths: scope.forbidden,
    })
    if (violations.length > 0) {
      const summary = violations.map((v) => `  - [${v.kind}] ${v.file}`).join('\n')
      const fullDiff = captureFullDiff(cwd, task.base_sha)
      const diffPath = join(ctx.logsDir, `${task.id}.scope-violation-review-iter-${iter}.diff`)
      writeFileSync(diffPath, fullDiff)
      logger.block(`SCOPE VIOLATION (review iter ${iter})`, `${summary}\n\nFull diff: ${diffPath}`)
      revertWorktree(cwd, task.base_sha)
      task.blocked_reason = `Scope violation after reviewer fix iter ${iter}.`
      return 'blocked'
    }
    const gates = task.gates.length > 0 ? task.gates : ctx.config.gates
    const gateResult = runGates(gates, cwd)
    if (!gateResult.ok) {
      logger.block(`GATES FAILED (review iter ${iter})`, summariseFailures(gateResult.results))
      task.blocked_reason = `Deterministic gates failed after reviewer fix iter ${iter}.`
      return 'blocked'
    }

    // Cycle complete: reviewer + fix + scope + gates all evaluated
    // successfully. Loop continues to iter K+1.
    markIterCompleted()
  }

  // Final-verify pass: the for loop exhausted iterations but the most recent
  // fix passed scope + gates. Run one extra reviewer call to confirm READY
  // before declaring blocked. Catches the case where the last review iter
  // flagged a trivial issue the implementer already addressed.
  //
  // Resume safety: if a previous run paused or was killed during final-
  // verify, `completed_review_iterations` already equals max (set when
  // the last regular iter terminated), so this function re-enters here
  // naturally on resume and re-runs the final-verify call. The pass is
  // a single read-only reviewer turn; running it twice is idempotent.
  logger.block('FINAL VERIFY', `Reviewer iterations exhausted; running one final verification pass.`)
  const verifyRun = await invokeReviewer(ctx, task, cwd, runningSummary, maxReviewIterations + 1, logger, 'reviewer final-verify')
  if (verifyRun.capacityHit) {
    pauseForCapacity(ctx, state, task, logger, 'reviewer', verifyRun.capacitySignal ?? 'capacity hit', 'final-verify')
    return 'paused'
  }

  const finalReviewResult = readReview(cwd, task.id)
  if (!finalReviewResult.data) {
    const why = finalReviewResult.reason ?? 'no review file written'
    logger.line(`Final-verify reviewer: ${why}. Treating as BLOCKED.`)
    task.blocked_reason = `Max review iterations (${maxReviewIterations}) exceeded; final-verify problem: ${why}`
    return 'blocked'
  }
  const finalReview = finalReviewResult.data
  if (finalReview.verdict === 'READY' && finalReview.issues.length === 0) {
    logger.block('FINAL VERIFY READY', finalReview.notes || 'No notes.')
    return 'ready'
  }
  if (finalReview.verdict === 'READY' && finalReview.issues.length > 0) {
    logger.line(`Final-verify returned READY with ${finalReview.issues.length} issue(s); strict mode treats this as BLOCKED.`)
  }
  task.blocked_reason = `Max review iterations (${maxReviewIterations}) exceeded; final-verify still BLOCKED.`
  logger.block('FINAL VERIFY BLOCKED', finalReview.issues.map((i) => `  - [${i.severity}] ${i.description}`).join('\n'))
  return 'blocked'
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface InvokeOutcome {
  capacityHit: boolean
  capacitySignal?: string
}

async function invokeImplementer(
  ctx: RuntimeContext,
  task: Task,
  cwd: string,
  mode: ImplementerMode,
  extra: string,
  attemptOrIter: number,
  logger: TaskLogger,
  label: string = `implementer attempt ${attemptOrIter}`,
): Promise<InvokeOutcome> {
  const agent = ctx.config.agents.implementer
  const systemPrompt = buildSystemPrompt(
    loadPromptFile(ctx.projectRoot, ctx.config.prompts.implementer),
    ctx.config,
  )
  const userPrompt = buildImplementerUserPrompt(task, mode, extra, ctx.config)

  logger.line(`Invoking ${agent.name} (${label}) in ${cwd}`)
  const t0 = Date.now()
  const result = await agent.invoke(
    {
      systemPrompt,
      userPrompt,
      cwd,
      taskId: task.id,
      label,
      allowedTools: IMPLEMENTER_TOOLS,
      timeoutMs: ctx.config.limits?.agentTurnTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS,
    },
    (event: AgentEvent) => streamEventToLogger(logger, event),
  )
  logger.line(`${agent.name} (${label}) finished in ${Date.now() - t0}ms; exit ${result.status}`)
  return { capacityHit: result.capacityHit, capacitySignal: result.capacitySignal }
}

async function invokeReviewer(
  ctx: RuntimeContext,
  task: Task,
  cwd: string,
  implementerSummary: string,
  iter: number,
  logger: TaskLogger,
  label: string = `reviewer iter ${iter}`,
): Promise<InvokeOutcome> {
  const agent = ctx.config.agents.reviewer
  const systemPrompt = buildSystemPrompt(
    loadPromptFile(ctx.projectRoot, ctx.config.prompts.reviewer),
    ctx.config,
  )
  const userPrompt = buildReviewerUserPrompt(task, implementerSummary, ctx.config)

  logger.line(`Invoking ${agent.name} (${label}) in ${cwd}`)
  const t0 = Date.now()
  const result = await agent.invoke(
    {
      systemPrompt,
      userPrompt,
      cwd,
      taskId: task.id,
      label,
      allowedTools: REVIEWER_TOOLS,
      timeoutMs: ctx.config.limits?.agentTurnTimeoutMs ?? DEFAULT_AGENT_TURN_TIMEOUT_MS,
    },
    (event: AgentEvent) => streamEventToLogger(logger, event),
  )
  logger.line(`${agent.name} (${label}) finished in ${Date.now() - t0}ms; exit ${result.status}`)
  return { capacityHit: result.capacityHit, capacitySignal: result.capacitySignal }
}

function streamEventToLogger(logger: TaskLogger, event: AgentEvent): void {
  switch (event.kind) {
    case 'text':
      process.stdout.write(event.text)
      logger.raw(event.text)
      break
    case 'tool_use':
      process.stdout.write(`\n  → ${event.name}\n`)
      logger.raw(`\n  → ${event.name} ${JSON.stringify(event.input).slice(0, 200)}\n`)
      break
    case 'tool_result':
      if (!event.ok && event.snippet) {
        process.stdout.write(`  ✗ ${event.snippet}\n`)
        logger.raw(`  ✗ ${event.snippet}\n`)
      }
      break
    case 'error':
      process.stderr.write(`[error] ${event.message}\n`)
      logger.raw(`[error] ${event.message}\n`)
      break
    case 'thinking':
      // Hidden from terminal; not appended to log.
      break
  }
}

function pauseForCapacity(
  ctx: RuntimeContext,
  state: RunState,
  task: Task,
  logger: TaskLogger,
  phase: NonNullable<Task['paused_phase']>,
  signal: string,
  label: string,
): void {
  task.status = 'waiting_for_capacity'
  task.paused_phase = phase
  task.blocked_reason = `Capacity hit during ${label}: "${signal}". Reset and re-run after the cap window resets.`
  logger.block(
    'WAITING FOR CAPACITY',
    `Phase: ${phase}\nLabel: ${label}\nSignal: ${signal}\n\nState saved. Re-run \`choirmaster run --resume\` (or --reset for a clean retry) once capacity returns.`,
  )
  saveState(ctx.runDir, state)
}

function blockTask(
  ctx: RuntimeContext,
  state: RunState,
  task: Task,
  logger: TaskLogger,
  reason: string,
): void {
  task.status = 'blocked'
  task.blocked_reason = reason
  logger.block('BLOCKED', reason)
  saveState(ctx.runDir, state)
}

async function handlePostReview(
  ctx: RuntimeContext,
  state: RunState,
  task: Task,
  handle: SandboxHandle,
  logger: TaskLogger,
  outcome: ReviewerOutcome,
  summary: string,
  options: RunTaskOptions,
): Promise<void> {
  const cwd = handle.cwd
  if (outcome === 'paused') {
    // pauseForCapacity already saved state.
    return
  }
  if (outcome === 'blocked') {
    task.status = 'blocked'
    task.blocked_reason = task.blocked_reason
      ?? `Reviewer iterations (${resolveMaxReviewIterations(task, ctx.config)}) exceeded.`
    logger.block('BLOCKED', task.blocked_reason)
    saveState(ctx.runDir, state)
    return
  }

  // READY: re-check scope one more time immediately before commit. The
  // earlier checks (post-implementer, post-fix) trust that nothing else
  // touched the worktree between then and now; this defends against any
  // stray edit, races against late agent processes, and serves as the
  // last gate before `git add -A` lands committed-everything.
  if (!task.base_sha) {
    return blockTask(ctx, state, task, logger, 'task.base_sha missing at commit time')
  }
  const finalChanged = getChangedFiles(cwd, task.base_sha)
  const finalScope = effectiveScope(task, ctx.config.forbiddenPaths)
  const finalViolations = checkScope({
    changedFiles: finalChanged,
    allowedPaths: finalScope.allowed,
    forbiddenPaths: finalScope.forbidden,
  })
  if (finalViolations.length > 0) {
    const summaryText = finalViolations.map((v) => `  - [${v.kind}] ${v.file}`).join('\n')
    const fullDiff = captureFullDiff(cwd, task.base_sha)
    const diffPath = join(ctx.logsDir, `${task.id}.scope-violation-pre-commit.diff`)
    writeFileSync(diffPath, fullDiff)
    logger.block('SCOPE VIOLATION (pre-commit)', `${summaryText}\n\nFull diff: ${diffPath}`)
    revertWorktree(cwd, task.base_sha)
    return blockTask(ctx, state, task, logger, `Pre-commit scope violation:\n${summaryText}`)
  }

  let sha: string
  try {
    sha = commitWorktree(task, handle, { summary })
    task.commit = sha
    task.status = 'completed'
    task.completed_at = new Date().toISOString()
    task.paused_phase = undefined
    task.last_summary = undefined
    task.last_review_issues = undefined
    logger.block('COMPLETED', `Committed ${sha} on ${task.branch}.`)
    saveState(ctx.runDir, state)
  }
  catch (err) {
    return blockTask(ctx, state, task, logger, `Commit failed: ${(err as Error).message}`)
  }

  if (options.skipAutoMerge) {
    logger.line(`skipAutoMerge set; leaving ${task.branch} unmerged.`)
    return
  }

  const rootBranch = currentBranch(ctx.projectRoot)
  if (rootBranch !== task.base_ref) {
    task.status = 'blocked'
    task.blocked_reason = `Skipped auto-merge: project root is on '${rootBranch}', expected '${task.base_ref}'. Switch back and merge manually.`
    logger.block('BLOCKED - BASE BRANCH DRIFTED', task.blocked_reason)
    saveState(ctx.runDir, state)
    return
  }

  // Await the branch policy. Without this, the next task could start
  // before the merge lands, racing the merge against the next worktree's
  // base. A late-arriving error could also flip an already-completed task
  // back to blocked after the caller has moved on.
  try {
    const outcomeKind = await ctx.config.branchPolicy.onTaskCompleted(ctx.projectRoot, task)
    logger.block('BRANCH POLICY', formatCompletionOutcome(outcomeKind))
    if (outcomeKind.kind === 'conflict' || outcomeKind.kind === 'failed') {
      task.status = 'blocked'
      task.blocked_reason = outcomeKind.kind === 'conflict'
        ? `Auto-merge conflict: ${outcomeKind.details}`
        : `Branch policy failed: ${outcomeKind.reason}`
    }
    saveState(ctx.runDir, state)
  }
  catch (err) {
    task.status = 'blocked'
    task.blocked_reason = `Branch policy threw: ${(err as Error).message}`
    logger.block('BLOCKED - BRANCH POLICY THREW', task.blocked_reason)
    saveState(ctx.runDir, state)
  }
}

function formatCompletionOutcome(outcome: CompletionOutcome): string {
  switch (outcome.kind) {
    case 'merged':
      return `Merged ${outcome.sha.slice(0, 8)} into ${outcome.into}.`
    case 'left-on-branch':
      return `Left on branch ${outcome.branch} at ${outcome.sha.slice(0, 8)}.`
    case 'pull-request-opened':
      return `Opened PR ${outcome.url}${outcome.number ? ` (#${outcome.number})` : ''}.`
    case 'conflict':
      return `Conflict merging into ${outcome.into}: ${outcome.details}`
    case 'failed':
      return `Failed: ${outcome.reason}`
  }
}
