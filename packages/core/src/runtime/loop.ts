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
  task.max_attempts = task.max_attempts || ctx.config.limits?.maxAttempts || DEFAULT_MAX_ATTEMPTS
  task.max_review_iterations = task.max_review_iterations
    || ctx.config.limits?.maxReviewIterations
    || DEFAULT_MAX_REVIEW_ITERATIONS

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
    // Auto-reuse the worktree when resuming a capacity pause - the
    // worktree was created on the prior run and still has the agent's
    // edits. The CLI flag is an additional manual override.
    const allowReuse = previousStatus === 'waiting_for_capacity' || (options.allowReuseWorktree ?? false)
    sandboxHandle = await ctx.config.sandbox.setup(task, ctx.projectRoot, { allowReuse })
    cwd = sandboxHandle.cwd
    logger.line(`Sandbox ready at ${sandboxHandle.cwd} (base ${task.base_ref}@${task.base_sha?.slice(0, 8)})`)
  }
  catch (err) {
    return blockTask(ctx, state, task, logger, `sandbox.setup failed: ${(err as Error).message}`)
  }

  // ── Phase-aware resume routing ────────────────────────────────────────────
  // If the previous run paused inside the reviewer, the implementer has
  // already produced a successful diff; jump straight to the reviewer loop.
  // implementer_fix is treated similarly for v0.1 (both go to reviewer).
  if (previousPausedPhase === 'reviewer' || previousPausedPhase === 'implementer_fix') {
    logger.block('RESUME', `Previous paused phase: ${previousPausedPhase}. Re-entering reviewer at iteration ${previousReviewIterations + 1}.`)
    const review = await runReviewerLoop(
      ctx,
      state,
      task,
      cwd,
      previousLastSummary || `${task.title}`,
      previousReviewIterations,
      previousLastReviewIssues,
      logger,
    )
    return handlePostReview(ctx, state, task, sandboxHandle, logger, review, previousLastSummary, options)
  }

  // ── Implementer attempt loop ──────────────────────────────────────────────
  let lastFailureSummary = ''
  let lastSummary = previousLastSummary

  const startAttempt = previousAttempts > 0 && previousStatus === 'pending'
    ? previousAttempts + 1
    : 1
  if (startAttempt > task.max_attempts) {
    return blockTask(
      ctx,
      state,
      task,
      logger,
      `Max attempts (${task.max_attempts}) already exhausted before resume; reset the task to retry.`,
    )
  }

  for (let attempt = startAttempt; attempt <= task.max_attempts; attempt++) {
    task.attempts = attempt
    saveState(ctx.runDir, state)

    const mode: ImplementerMode = attempt === 1 ? 'INITIAL_IMPLEMENTATION' : 'FIX_CHECK_FAILURES'
    const extra = attempt === 1
      ? 'Implement the spec end-to-end; self-review your diff before writing the handoff file.'
      : `Previous attempt failed deterministic checks. Failure output:\n\n${lastFailureSummary || '(see logs)'}`

    const claude = await invokeImplementer(ctx, task, cwd, mode, extra, attempt, logger)

    if (claude.capacityHit) {
      return pauseForCapacity(ctx, state, task, logger, 'implementer', claude.capacitySignal ?? 'capacity hit', `attempt ${attempt}`)
    }

    const handoffResult = readHandoff(cwd, task.id)
    if (!handoffResult.data) {
      const why = handoffResult.reason ?? 'no handoff file written'
      logger.line(`Implementer attempt ${attempt}: ${why}. Treating as failed attempt.`)
      lastFailureSummary = `Handoff problem: ${why}`
      continue
    }
    const handoff = handoffResult.data
    lastSummary = handoff.summary_of_changes ?? handoff.notes ?? ''
    task.last_summary = lastSummary
    saveState(ctx.runDir, state)

    if (handoff.verdict === 'BLOCKED') {
      return blockTask(ctx, state, task, logger, `Implementer blocked: ${handoff.notes}`)
    }
    if (handoff.verdict === 'NEEDS_FIXES') {
      logger.line(`Implementer reported NEEDS_FIXES on attempt ${attempt}; routing back as a fresh attempt.`)
      lastFailureSummary = handoff.notes || 'Implementer self-flagged NEEDS_FIXES'
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
      continue
    }

    // Deterministic gates
    const gates = task.gates.length > 0 ? task.gates : ctx.config.gates
    const gateResult = runGates(gates, cwd)
    if (!gateResult.ok) {
      const failureSummary = summariseFailures(gateResult.results)
      logger.block(`GATES FAILED (attempt ${attempt})`, failureSummary)
      lastFailureSummary = failureSummary
      continue
    }

    // All green. Move to reviewer.
    logger.block(`GATES PASSED (attempt ${attempt})`, 'All deterministic checks green.')
    task.review_iterations = 0
    saveState(ctx.runDir, state)
    const review = await runReviewerLoop(ctx, state, task, cwd, lastSummary, 0, '', logger)
    return handlePostReview(ctx, state, task, sandboxHandle, logger, review, lastSummary, options)
  }

  return blockTask(
    ctx,
    state,
    task,
    logger,
    `Max implementation attempts (${task.max_attempts}) exhausted - checks never went green.`,
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
  previousReviewIterations: number,
  previousLastReviewIssues: string,
  logger: TaskLogger,
): Promise<ReviewerOutcome> {
  const startIter = previousReviewIterations > 0 ? previousReviewIterations + 1 : 1
  if (startIter > task.max_review_iterations) {
    task.blocked_reason = `Max review iterations (${task.max_review_iterations}) already exhausted.`
    return 'blocked'
  }

  let lastReviewIssues = previousLastReviewIssues
  let runningSummary = implementerSummary

  for (let iter = startIter; iter <= task.max_review_iterations; iter++) {
    task.review_iterations = iter
    saveState(ctx.runDir, state)

    const reviewerRun = await invokeReviewer(ctx, task, cwd, runningSummary, iter, logger)
    if (reviewerRun.capacityHit) {
      pauseForCapacity(ctx, state, task, logger, 'reviewer', reviewerRun.capacitySignal ?? 'capacity hit', `iter ${iter}`)
      return 'paused'
    }

    const reviewResult = readReview(cwd, task.id)
    if (!reviewResult.data) {
      const why = reviewResult.reason ?? 'no review file written'
      logger.line(`Reviewer iter ${iter}: ${why}. Treating as BLOCKED.`)
      continue
    }
    const review = reviewResult.data
    if (review.verdict === 'READY') {
      logger.block(`REVIEWER READY (iter ${iter})`, review.notes || 'No notes.')
      return 'ready'
    }

    // BLOCKED → feed issues to implementer fix
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
  }

  // Final-verify pass: the for loop exhausted iterations but the most recent
  // fix passed scope + gates. Run one extra reviewer call to confirm READY
  // before declaring blocked. Catches the case where the last review iter
  // flagged a trivial issue the implementer already addressed.
  logger.block('FINAL VERIFY', `Reviewer iterations exhausted; running one final verification pass.`)
  const verifyRun = await invokeReviewer(ctx, task, cwd, runningSummary, task.max_review_iterations + 1, logger, 'reviewer final-verify')
  if (verifyRun.capacityHit) {
    pauseForCapacity(ctx, state, task, logger, 'reviewer', verifyRun.capacitySignal ?? 'capacity hit', 'final-verify')
    return 'paused'
  }
  const finalReviewResult = readReview(cwd, task.id)
  if (!finalReviewResult.data) {
    const why = finalReviewResult.reason ?? 'no review file written'
    logger.line(`Final-verify reviewer: ${why}. Treating as BLOCKED.`)
    task.blocked_reason = `Max review iterations (${task.max_review_iterations}) exceeded; final-verify problem: ${why}`
    return 'blocked'
  }
  const finalReview = finalReviewResult.data
  if (finalReview.verdict === 'READY') {
    logger.block('FINAL VERIFY READY', finalReview.notes || 'No notes.')
    return 'ready'
  }
  task.blocked_reason = `Max review iterations (${task.max_review_iterations}) exceeded; final-verify still BLOCKED.`
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
      ?? `Reviewer iterations (${task.max_review_iterations}) exceeded.`
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
