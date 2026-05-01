import { spawnSync } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { currentBranch, git, type AgentRoles, type ProjectConfig, type ProjectPrompts } from '@choirmaster/core'
import type { Agent } from '@choirmaster/core'

import { loadManifest } from '../manifest.js'

type CheckStatus = 'ok' | 'warn' | 'fail'

interface DoctorCheck {
  status: CheckStatus
  name: string
  detail: string
}

interface CommandResult {
  status: number | null
  stdout?: string | Buffer
  stderr?: string | Buffer
  error?: Error
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { cwd?: string; encoding: 'utf8'; timeout?: number },
) => CommandResult

type LookupHost = (host: string) => Promise<unknown>

export interface DoctorCommandArgs {
  cwd?: string
  skipNetwork?: boolean
  commandRunner?: CommandRunner
  lookupHost?: LookupHost
}

export async function doctorCommand(args: DoctorCommandArgs = {}): Promise<number> {
  const projectRoot = resolve(args.cwd ?? process.cwd())
  const commandRunner = args.commandRunner ?? runCommand
  const lookupHost = args.lookupHost ?? ((host: string) => lookup(host))
  const checks: DoctorCheck[] = []

  checks.push(checkNodeVersion())
  checks.push(checkGitBinary(projectRoot, commandRunner))

  const repo = git(['rev-parse', '--show-toplevel'], projectRoot)
  if (repo.status !== 0) {
    checks.push({
      status: 'fail',
      name: 'git repository',
      detail: 'not inside a working git repository',
    })
    printChecks(checks)
    return 1
  }

  const repoRoot = repo.stdout.trim()
  checks.push({
    status: 'ok',
    name: 'git repository',
    detail: repoRoot,
  })

  let config: ProjectConfig | null = null
  try {
    config = await loadManifest(projectRoot)
    checks.push({
      status: 'ok',
      name: 'manifest',
      detail: '.choirmaster/manifest.* loaded',
    })
  }
  catch (err) {
    checks.push({
      status: 'fail',
      name: 'manifest',
      detail: (err as Error).message,
    })
  }

  if (config) {
    checks.push(checkBaseBranch(projectRoot, config))
    checks.push(...checkPrompts(projectRoot, config))
    checks.push(...checkAgents(config))
    checks.push(...await checkAgentCLIs(config, commandRunner))
    checks.push(...await checkNetwork(config, {
      lookupHost,
      skipNetwork: args.skipNetwork ?? false,
    }))
    checks.push(...checkGates(config))
    checks.push(checkBranchPolicy(config))
    checks.push(checkSandbox(config))
    checks.push(checkRunsGitignore(projectRoot))
    checks.push(checkForbiddenPaths(config))
  }

  printChecks(checks)
  return checks.some((check) => check.status === 'fail') ? 1 : 0
}

const runCommand: CommandRunner = (command, args, options) => spawnSync(command, args, options)

function checkNodeVersion(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10)
  if (major >= 20) {
    return { status: 'ok', name: 'node', detail: process.version }
  }
  return {
    status: 'fail',
    name: 'node',
    detail: `Node ${process.version}; ChoirMaster requires Node >=20`,
  }
}

function checkGitBinary(cwd: string, commandRunner: CommandRunner): DoctorCheck {
  const result = commandRunner('git', ['--version'], { cwd, encoding: 'utf8' })
  if (result.status === 0) {
    return { status: 'ok', name: 'git binary', detail: stringifyOutput(result.stdout).trim() }
  }
  return {
    status: 'fail',
    name: 'git binary',
    detail: result.error?.message ?? stringifyOutput(result.stderr).trim() ?? 'git is not available on PATH',
  }
}

function checkBaseBranch(projectRoot: string, config: ProjectConfig): DoctorCheck {
  const branch = currentBranch(projectRoot)
  if (branch === config.base) {
    return { status: 'ok', name: 'base branch', detail: `on ${branch}` }
  }
  if (!branch) {
    return {
      status: 'fail',
      name: 'base branch',
      detail: `detached HEAD; run git checkout ${config.base} before choirmaster run`,
    }
  }
  return {
    status: 'fail',
    name: 'base branch',
    detail: `on ${branch}; manifest.base is ${config.base}; run git checkout ${config.base} before choirmaster run`,
  }
}

function checkPrompts(projectRoot: string, config: ProjectConfig): DoctorCheck[] {
  const prompts = config.prompts as Partial<ProjectPrompts>
  const checks: DoctorCheck[] = []
  for (const role of ['planner', 'implementer', 'reviewer'] as const) {
    checks.push(checkPrompt(projectRoot, `prompt:${role}`, prompts[role]))
  }

  if (prompts.planReviewer) {
    checks.push(checkPrompt(projectRoot, 'prompt:planReviewer', prompts.planReviewer))
  }
  else {
    checks.push({
      status: config.agents.planReviewer ? 'fail' : 'ok',
      name: 'prompt:planReviewer',
      detail: config.agents.planReviewer
        ? 'missing prompt path for configured planReviewer agent'
        : 'not configured; optional until plan-review iteration ships',
    })
  }
  return checks
}

function checkPrompt(projectRoot: string, name: string, rel: string | undefined): DoctorCheck {
  if (!rel) {
    return {
      status: 'fail',
      name,
      detail: 'missing prompt path',
    }
  }
  const exists = existsSync(join(projectRoot, rel))
  return {
    status: exists ? 'ok' : 'fail',
    name,
    detail: exists ? rel : `missing ${rel}`,
  }
}

function checkAgents(config: ProjectConfig): DoctorCheck[] {
  const roles: (keyof AgentRoles)[] = ['planner', 'implementer', 'reviewer']
  const checks: DoctorCheck[] = []
  for (const role of roles) {
    const agent = config.agents[role]
    if (!agent) {
      checks.push({ status: 'fail', name: `agent:${role}`, detail: 'not configured' })
      continue
    }
    checks.push({
      status: 'ok',
      name: `agent:${role}`,
      detail: `${agent.name} (${agent.engine}:${agent.model})`,
    })
  }

  const planReviewer = config.agents.planReviewer
  checks.push({
    status: 'ok',
    name: 'agent:planReviewer',
    detail: planReviewer
      ? `${planReviewer.name} (${planReviewer.engine}:${planReviewer.model})`
      : 'not configured; optional until plan-review iteration ships',
  })
  return checks
}

async function checkAgentCLIs(config: ProjectConfig, commandRunner: CommandRunner): Promise<DoctorCheck[]> {
  const engines = configuredEngines(config)
  const checks: DoctorCheck[] = []

  if (engines.has('claude')) {
    const result = commandRunner('claude', ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
    })
    if (result.status === 0) {
      checks.push({
        status: 'ok',
        name: 'claude CLI',
        detail: stringifyOutput(result.stdout || result.stderr).trim(),
      })
    }
    else {
      checks.push({
        status: 'fail',
        name: 'claude CLI',
        detail: result.error?.message ?? stringifyOutput(result.stderr).trim() ?? 'claude --version failed',
      })
    }
  }

  return checks
}

async function checkNetwork(
  config: ProjectConfig,
  options: { lookupHost: LookupHost; skipNetwork: boolean },
): Promise<DoctorCheck[]> {
  const engines = configuredEngines(config)
  const checks: DoctorCheck[] = []

  if (engines.has('claude')) {
    if (options.skipNetwork) {
      checks.push({
        status: 'warn',
        name: 'network:Anthropic DNS',
        detail: 'skipped (--skip-network)',
      })
    }
    else {
      checks.push(await dnsCheck('network:Anthropic DNS', 'api.anthropic.com', options.lookupHost))
    }
  }

  return checks
}

function checkGates(config: ProjectConfig): DoctorCheck[] {
  if (!Array.isArray(config.gates) || config.gates.length === 0) {
    return [{
      status: 'warn',
      name: 'gates',
      detail: 'no deterministic gates configured',
    }]
  }

  const malformed = config.gates
    .filter((gate) => !gate.name || !gate.command)
    .map((gate) => gate.name || '(unnamed)')
  if (malformed.length > 0) {
    return [{
      status: 'fail',
      name: 'gates',
      detail: `malformed gate(s): ${malformed.join(', ')}`,
    }]
  }

  return [{
    status: 'ok',
    name: 'gates',
    detail: `${config.gates.length} configured: ${config.gates.map((gate) => gate.name).join(', ')}`,
  }]
}

function checkBranchPolicy(config: ProjectConfig): DoctorCheck {
  return {
    status: config.branchPolicy?.name ? 'ok' : 'fail',
    name: 'branch policy',
    detail: config.branchPolicy?.name ?? 'missing branchPolicy.name',
  }
}

function checkSandbox(config: ProjectConfig): DoctorCheck {
  const sandboxName = config.sandbox?.name
  if (!sandboxName) {
    return {
      status: 'fail',
      name: 'sandbox',
      detail: 'missing sandbox.name',
    }
  }

  const prepare = config.sandbox.prepare?.command
  if (prepare) {
    return {
      status: 'ok',
      name: 'sandbox',
      detail: `${sandboxName}; prepare: ${prepare}`,
    }
  }

  const hasGates = Array.isArray(config.gates) && config.gates.length > 0
  return {
    status: hasGates ? 'warn' : 'ok',
    name: 'sandbox',
    detail: hasGates
      ? `${sandboxName}; no prepare hook, so fresh worktrees may miss dependencies`
      : sandboxName,
  }
}

function checkRunsGitignore(projectRoot: string): DoctorCheck {
  const result = git(['check-ignore', '-q', '.choirmaster/runs/doctor'], projectRoot)
  if (result.status === 0) {
    return {
      status: 'ok',
      name: 'gitignore',
      detail: '.choirmaster/runs/ is ignored',
    }
  }
  return {
    status: 'warn',
    name: 'gitignore',
    detail: '.choirmaster/runs/ is not ignored; run choirmaster init or update .gitignore',
  }
}

function checkForbiddenPaths(config: ProjectConfig): DoctorCheck {
  const paths = config.forbiddenPaths ?? []
  const protectsEnv = paths.some((path) => path === '.env' || path === '.env.*' || path === '.env/**')
  if (protectsEnv) {
    return {
      status: 'ok',
      name: 'forbidden paths',
      detail: `${paths.length} configured`,
    }
  }
  return {
    status: 'warn',
    name: 'forbidden paths',
    detail: 'consider adding .env and .env.*',
  }
}

function configuredEngines(config: ProjectConfig): Set<string> {
  const agents = [
    config.agents.planner,
    config.agents.planReviewer,
    config.agents.implementer,
    config.agents.reviewer,
  ].filter((agent): agent is Agent => Boolean(agent))
  return new Set(agents.map((agent) => agent.engine))
}

async function dnsCheck(name: string, host: string, lookupHost: LookupHost): Promise<DoctorCheck> {
  try {
    await withTimeout(lookupHost(host), 3000)
    return { status: 'ok', name, detail: host }
  }
  catch (err) {
    return {
      status: 'warn',
      name,
      detail: `could not resolve ${host}: ${(err as Error).message}; agent turns may fail if you are offline`,
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
      }),
    ])
  }
  finally {
    if (timeout) clearTimeout(timeout)
  }
}

function printChecks(checks: DoctorCheck[]): void {
  process.stdout.write('\nChoirMaster doctor\n\n')
  for (const check of checks) {
    process.stdout.write(`${label(check.status)} ${check.name}: ${check.detail}\n`)
  }

  const failures = checks.filter((check) => check.status === 'fail').length
  const warnings = checks.filter((check) => check.status === 'warn').length
  process.stdout.write(`\n${checks.length} checks: ${failures} failed, ${warnings} warning(s)\n`)
  if (failures > 0) {
    process.stdout.write('Fix failed checks before running ChoirMaster.\n')
  }
}

function label(status: CheckStatus): string {
  switch (status) {
    case 'ok':
      return '[ok]'
    case 'warn':
      return '[warn]'
    case 'fail':
      return '[fail]'
  }
}

function stringifyOutput(output: string | Buffer | undefined): string {
  return output?.toString() ?? ''
}
