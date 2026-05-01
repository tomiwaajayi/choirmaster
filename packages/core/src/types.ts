/**
 * ChoirMaster core type system.
 *
 * The shape of every contract that flows between the planner, the runtime,
 * and the user-authored project config. Stable surface; runtime mechanics
 * import from here, plugins implement the interfaces here, and the planner
 * emits values shaped like the records here.
 */

// ────────────────────────────────────────────────────────────────────────────
// Tasks
// ────────────────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'blocked'
  | 'waiting_for_capacity'

export type PausedPhase = 'implementer' | 'reviewer' | 'implementer_fix'

/**
 * One unit of work within a Run. Compiled by the planner from a plan input;
 * executed by the runtime. Mutable runtime fields (status, attempts, ...)
 * live alongside the contract for resume-safety.
 */
export interface Task {
  /** Stable id, e.g. "TASK-03". Surfaces in logs and CLI output. */
  id: string
  /** Human-readable name. */
  title: string
  /** Free-form context for the implementer. */
  description?: string
  /** Pointer back to the plan section that produced this task. */
  spec_section?: string
  /** Branch the worktree forks to and the implementer commits on. */
  branch: string
  /** Worktree path relative to the project root. */
  worktree: string
  /** Globs the implementer may edit. Anything else is a scope violation. */
  allowed_paths: string[]
  /** Globs the implementer must not edit. Takes precedence over allowed_paths. */
  forbidden_paths: string[]
  /** Deterministic gates run after every implementer turn. */
  gates: GateConfig[]
  /** What makes this task READY. The reviewer checks against this. */
  definition_of_done: string[]
  /** Ids of tasks that must complete before this one starts. */
  depends_on?: string[]
  /**
   * Per-task overrides. Values default to the project-level config when
   * omitted. Use these when a single task needs a different sandbox
   * (e.g. one task needs Docker isolation), a different branch policy
   * (e.g. one task should open a PR while others auto-merge), or a
   * different agent set (e.g. a tricky refactor wants Opus where the
   * default is Sonnet).
   */
  overrides?: TaskOverrides

  // Runtime mutable state (preserved across orchestrator runs for resume).
  attempts: number
  max_attempts: number
  review_iterations: number
  max_review_iterations: number
  status: TaskStatus
  /** Branch name the worktree was created from. Captured at worktree creation. */
  base_ref?: string
  /** SHA the worktree was created from. Used for deterministic scope diffs. */
  base_sha?: string
  /** Phase the task was inside when capacity ran out. */
  paused_phase?: PausedPhase
  /** Implementer's last summary; passed to reviewer on resume. */
  last_summary?: string
  /** Reviewer issues from the iter that triggered the implementer fix; */
  /** persisted so an implementer_fix-phase resume can re-prompt with them. */
  last_review_issues?: string
  blocked_reason?: string
  commit?: string
  completed_at?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Gates (deterministic checks)
// ────────────────────────────────────────────────────────────────────────────

export interface GateConfig {
  /** Display name in logs ("typecheck", "test", "audit:ui-copy"). */
  name: string
  /** Shell command to execute. cwd is the worktree root. */
  command: string
  /** Optional human description of what this gate enforces. */
  description?: string
}

export interface GateResult {
  name: string
  ok: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
}

// ────────────────────────────────────────────────────────────────────────────
// Agents (Claude, Codex, ...)
// ────────────────────────────────────────────────────────────────────────────

export interface AgentInvokeOpts {
  /** The agent's role definition. */
  systemPrompt: string
  /** The task brief. */
  userPrompt: string
  /** Worktree path the agent operates in. */
  cwd: string
  /** Tool allowlist (engine-specific format; passed verbatim). */
  allowedTools?: string[]
  /** For log correlation. */
  taskId: string
  /** Phase label, e.g. "implementer attempt 1". */
  label: string
  /** Optional cap; agents may ignore. */
  timeoutMs?: number
}

export interface AgentResult {
  /** Process exit status; null on signal. */
  status: number | null
  /** Captured stdout (raw). */
  stdout: string
  /** Captured stderr. */
  stderr: string
  /** Wall time. */
  durationMs: number
  /** Whether the underlying CLI signaled a usage / capacity error. */
  capacityHit: boolean
  /** The matched signal, if capacityHit. */
  capacitySignal?: string
}

/**
 * An event emitted while an agent is working. Streamed to caller for live UI.
 * Agents map their native protocol (stream-json for Claude, etc.) into these
 * canonical shapes so the runtime's logger doesn't need to know the engine.
 */
export type AgentEvent =
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; ok: boolean; snippet?: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'error'; message: string }

export interface Agent {
  /** Display name for logs and CLI output, e.g. "claude:opus". */
  readonly name: string
  /**
   * Engine identifier the runtime can use to recreate this agent with a
   * different model at run time. Examples: "claude", "codex", "opencode".
   */
  readonly engine: string
  /**
   * Model identifier within the engine, e.g. "opus", "sonnet", "haiku",
   * "gpt-5.5", "codex-5.3". Free-form; engines validate.
   */
  readonly model: string
  /** Invoke one turn. Resolves when the turn ends. */
  invoke(
    opts: AgentInvokeOpts,
    onEvent?: (event: AgentEvent) => void,
  ): Promise<AgentResult>
}

/**
 * Engine factories live in their own packages (`@choirmaster/agent-claude`,
 * `@choirmaster/agent-codex`, etc.) and register themselves so the CLI can
 * resolve "claude:opus" or "codex:gpt-5.5" strings at runtime to a fresh
 * Agent. This is what lets `choirmaster set-model implementer claude:opus`
 * swap the implementer mid-run without editing the manifest.
 */
export interface AgentFactory {
  /** Engine identifier matched against the prefix of "engine:model" strings. */
  readonly engine: string
  /** Construct a new Agent for the given model id. */
  create(model: string, opts?: AgentFactoryOptions): Agent
}

export interface AgentFactoryOptions {
  /** Optional thinking-effort hint, where supported. */
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Per-call timeout in ms; null disables. */
  timeoutMs?: number | null
  /** Engine-specific arbitrary options. */
  extra?: Record<string, unknown>
}

// ────────────────────────────────────────────────────────────────────────────
// Handoff + Review (structured agent outputs)
// ────────────────────────────────────────────────────────────────────────────

export interface Handoff {
  task_id: string
  mode: string
  verdict: 'READY_FOR_REVIEW' | 'NEEDS_FIXES' | 'BLOCKED'
  scope_ok: boolean
  files_modified: string[]
  files_created: string[]
  files_deleted: string[]
  missed_requirements: string[]
  risky_changes: string[]
  out_of_scope_observations: string[]
  pushbacks: string[]
  notes: string
  summary_of_changes?: string
}

export interface ReviewIssue {
  axis: 'spec' | 'scope' | 'design-system' | string
  severity: 'high' | 'medium' | 'low'
  file: string
  line: number | null
  description: string
}

export interface Review {
  task_id: string
  verdict: 'READY' | 'BLOCKED'
  checked_at: string
  files_reviewed: string[]
  issues: ReviewIssue[]
  notes: string
}

// ────────────────────────────────────────────────────────────────────────────
// Sandbox (worktree, docker, remote)
// ────────────────────────────────────────────────────────────────────────────

export interface SandboxHandle {
  /** Path the agent uses as cwd. May differ from the host worktree path */
  /** when the sandbox is a container. */
  cwd: string
  /** Path on the host where edits land. */
  worktreePath: string
  /** Optional cleanup hook. */
  cleanup?: () => Promise<void>
}

export interface Sandbox {
  readonly name: string
  setup(task: Task, projectRoot: string): Promise<SandboxHandle>
  teardown?(handle: SandboxHandle): Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// Branch policy (how completed work rejoins the base branch)
// ────────────────────────────────────────────────────────────────────────────

/**
 * What happens after a task commits. Built-in factories cover the common
 * shapes (the runtime ships `headOnly()`, `perTaskMerge()`, `perTaskBranch()`,
 * `openPullRequest()` etc.); users can also implement BranchPolicy directly
 * for arbitrary completion behaviour.
 */
export type CompletionOutcome =
  /** Task commit was merged into the base branch on the host. */
  | { kind: 'merged'; into: string; sha: string }
  /** Task commit lives on its own branch; no merge happened. */
  | { kind: 'left-on-branch'; branch: string; sha: string }
  /** Branch was pushed and a pull request opened. */
  | { kind: 'pull-request-opened'; branch: string; sha: string; url: string; number?: number }
  /** Merge into base failed due to conflict. Base tree was left clean. */
  | { kind: 'conflict'; into: string; details: string }
  /** Anything else that prevented completion. */
  | { kind: 'failed'; reason: string }

export interface BranchPolicy {
  readonly name: string
  /**
   * What to do after a successful task commit. The runtime resolves the
   * base ref (from `ProjectConfig.base`) and assigns it to `task.base_ref`
   * before any policy method is called, so the policy can read it.
   */
  onTaskCompleted(projectRoot: string, task: Task): Promise<CompletionOutcome>
}

// ────────────────────────────────────────────────────────────────────────────
// Per-task overrides
// ────────────────────────────────────────────────────────────────────────────

/**
 * A task can override any subset of the project-level config. The runtime
 * reads project config first, applies these overrides on top, then applies
 * any active runtime overrides (set via `choirmaster set ...`) last.
 */
export interface TaskOverrides {
  agents?: Partial<AgentRoles>
  gates?: GateConfig[]
  sandbox?: Sandbox
  branchPolicy?: BranchPolicy
  /** Engine-specific options (effort, timeoutMs, etc.) layered on agent calls. */
  agentOptions?: Partial<Record<keyof AgentRoles, AgentFactoryOptions>>
}

// ────────────────────────────────────────────────────────────────────────────
// Run state (per-orchestrator-invocation)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Mid-run overrides applied dynamically via the CLI. Persists in the run
 * state so subsequent task invocations use the new selection, and survives
 * orchestrator restarts. Cleared by `choirmaster reset-overrides`.
 *
 * Each entry is a string of the form "engine:model" (e.g. "claude:opus",
 * "codex:gpt-5.5"). The runtime resolves these against registered
 * `AgentFactory` instances at invocation time.
 */
export interface RuntimeOverrides {
  models?: Partial<Record<keyof AgentRoles, string>>
  branchPolicy?: string
  sandbox?: string
}

export interface RunState {
  /** Run id; usually a timestamp + slug. */
  id: string
  /** Where the plan came from: a markdown path or "issue:N" or "label:foo". */
  plan_source: string
  started_at: string | null
  current_task: string | null
  tasks: Task[]
  /** Optional dynamic overrides set via the CLI mid-run. */
  runtime_overrides?: RuntimeOverrides
}

// ────────────────────────────────────────────────────────────────────────────
// Project config (the user-authored manifest.ts)
// ────────────────────────────────────────────────────────────────────────────

export interface AgentRoles {
  planner: Agent
  planReviewer?: Agent
  implementer: Agent
  reviewer: Agent
}

export interface ProjectLimits {
  /** Implementer attempts per task. Default 4. */
  maxAttempts?: number
  /** Reviewer iterations per task. Default 3. */
  maxReviewIterations?: number
  /** Plan-reviewer iterations per plan. Default 3. */
  maxPlanReviewIterations?: number
  /** Heartbeat interval in ms. Default 30000. */
  heartbeatIntervalMs?: number
  /** Per-turn timeout in ms; null disables. Default null. */
  agentTurnTimeoutMs?: number | null
}

export interface ProjectPrompts {
  planner: string
  planReviewer: string
  implementer: string
  reviewer: string
}

export interface ProjectConfig {
  /** Base branch tasks fork from (e.g. "main", "staging"). */
  base: string
  /** Agents per role. */
  agents: AgentRoles
  /** Default gates run after every implementer turn. Tasks may override. */
  gates: GateConfig[]
  /** How completed task branches merge. */
  branchPolicy: BranchPolicy
  /** Where worktrees and agent processes execute. */
  sandbox: Sandbox
  /** Paths to prompt files (relative to project root). */
  prompts: ProjectPrompts
  /**
   * Hard-blocked file globs that apply to every task in this project. The
   * runtime unions these with each task's per-task `forbidden_paths` to
   * compute the effective forbidden set. Edits to any matching path are
   * caught by the post-turn scope check, the worktree is reverted, and the
   * task attempt fails. The list is also injected into agent prompts so
   * the implementer sees the rule before making edits.
   *
   * Typical entries:
   *   .env, .env.*, package.json, pnpm-lock.yaml, package-lock.json,
   *   yarn.lock, server/database/migrations/**, .github/**, .git/**
   */
  forbiddenPaths?: string[]
  /**
   * Strict project-wide rules prepended to every implementer and reviewer
   * system prompt. Use for invariants the per-task DoD shouldn't have to
   * restate.
   *
   * Examples:
   *   "Never run package manager install commands."
   *   "Never modify files in server/database/migrations/."
   *   "Never commit secrets, API keys, or credentials."
   *   "Preserve all existing license headers."
   *   "Never use the em dash character (U+2014); use a hyphen instead."
   *
   * Each entry is rendered as a numbered list item in the prompt, so keep
   * each entry to a single imperative sentence.
   */
  strictInstructions?: string[]
  /** Optional per-project limit overrides. */
  limits?: ProjectLimits
}

/**
 * Type-helping identity function so users get full IntelliSense on the config
 * shape from a plain `export default defineProject({...})`.
 */
export function defineProject(config: ProjectConfig): ProjectConfig {
  return config
}
