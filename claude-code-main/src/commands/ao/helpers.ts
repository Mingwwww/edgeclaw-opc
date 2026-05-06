import { basename } from 'path'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { requestCronDaemon } from '../../daemon/client.js'
import { assertCronDaemonOk } from '../../daemon/ipc.js'
import type { DaemonListedCronTask } from '../../daemon/types.js'
import { asAgentId } from '../../types/ids.js'
import {
  type CronTask,
  listAllCronTasks,
} from '../../utils/cronTasks.js'
import {
  type DiscoveryPlanRecord,
  readDiscoveryPlanContent,
  readDiscoveryPlanIndex,
  writeDiscoveryPlanIndex,
} from '../../utils/alwaysOnDiscoveryPlans.js'
import { extractTextContent } from '../../utils/messages.js'
import { getAgentTranscript } from '../../utils/sessionStorage.js'

export type AoAction = 'help' | 'list' | 'run' | 'status'
export type AoTarget = 'all' | 'cron' | 'plan'
export type AoCronStatus =
  | 'scheduled'
  | 'running'
  | 'completed'
  | 'failed'
  | 'unknown'

export type ParsedAoArgs =
  | { action: 'help'; error?: string }
  | { action: 'list'; target: AoTarget }
  | { action: 'status'; target: Exclude<AoTarget, 'all'>; id: string }
  | { action: 'run'; target: Exclude<AoTarget, 'all'>; id: string }

export type AoCronOverview = CronTask & {
  status: AoCronStatus
  latestSummary?: string
  lastActivity?: string
}

const TARGET_ALIASES = new Map<string, Exclude<AoTarget, 'all'>>([
  ['cron', 'cron'],
  ['crons', 'cron'],
  ['job', 'cron'],
  ['jobs', 'cron'],
  ['cron-job', 'cron'],
  ['cron-jobs', 'cron'],
  ['plan', 'plan'],
  ['plans', 'plan'],
])

const DISCOVERY_PLAN_STATUS_ORDER: Record<string, number> = {
  running: 0,
  queued: 1,
  ready: 2,
  failed: 3,
  completed: 4,
  draft: 5,
  superseded: 6,
}

type TranscriptSummaryMessage = {
  type?: string
  content?: unknown
  timestamp?: string | number | Date
}

function normalizeTarget(value: string | undefined): Exclude<AoTarget, 'all'> | null {
  if (typeof value !== 'string') {
    return null
  }

  return TARGET_ALIASES.get(value.trim().toLowerCase()) ?? null
}

function normalizeText(value: string | undefined, fallback = '-'): string {
  if (typeof value !== 'string') {
    return fallback
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

function summarizeText(
  value: string | undefined,
  maxLength = 140,
  fallback = '-',
): string {
  const normalized = normalizeText(value, '')
  if (!normalized) {
    return fallback
  }

  const collapsed = normalized.replace(/\s+/g, ' ')
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength - 3)}...`
    : collapsed
}

function formatDateTime(
  value: string | number | Date | undefined,
  fallback = '-',
): string {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return fallback
  }

  return date.toLocaleString()
}

function normalizeTaskStatus(status: string | undefined): AoCronStatus | null {
  switch (status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
    case 'killed':
      return 'failed'
    default:
      return null
  }
}

function getDiscoveryPlanStatus(plan: DiscoveryPlanRecord): string {
  if (plan.status === 'superseded') {
    return 'superseded'
  }

  if (plan.executionStatus === 'running') {
    return 'running'
  }
  if (plan.executionStatus === 'queued') {
    return 'queued'
  }
  if (plan.executionStatus === 'completed') {
    return 'completed'
  }
  if (plan.executionStatus === 'failed') {
    return 'failed'
  }

  return plan.status
}

async function listRuntimeCronTasks(): Promise<Map<string, DaemonListedCronTask>> {
  const response = await requestCronDaemon({
    type: 'list_tasks',
    projectRoot: getProjectRoot(),
    originSessionId: getSessionId(),
  })
  assertCronDaemonOk(response)
  if (response.data.type !== 'list_tasks') {
    throw new Error('Unexpected Cron daemon list response')
  }

  return new Map(response.data.tasks.map(task => [task.id, task]))
}

function mergeAoCronTasksById(
  tasks: readonly CronTask[],
  runtimeTasks: ReadonlyMap<string, DaemonListedCronTask>,
): CronTask[] {
  const merged = new Map<string, CronTask>(tasks.map(task => [task.id, task]))

  for (const runtimeTask of runtimeTasks.values()) {
    if (merged.has(runtimeTask.id)) {
      continue
    }

    const { running: _running, ...task } = runtimeTask
    merged.set(task.id, task)
  }

  return [...merged.values()]
}

async function readCronTranscriptSummary(
  task: CronTask,
): Promise<{ latestSummary?: string; lastActivity?: string }> {
  if (!task.transcriptKey) {
    return {}
  }

  const transcript = await getAgentTranscript(asAgentId(task.transcriptKey))
  if (!transcript || transcript.messages.length === 0) {
    return {}
  }

  const transcriptMessages = transcript.messages as TranscriptSummaryMessage[]
  const lastAssistantMessage = [...transcriptMessages]
    .reverse()
    .find(message => message.type === 'assistant')
  const lastMessage = transcriptMessages.at(-1)
  const lastActivity =
    typeof lastMessage?.timestamp === 'string'
      ? lastMessage.timestamp
      : typeof lastMessage?.timestamp === 'number'
        ? new Date(lastMessage.timestamp).toISOString()
        : lastMessage?.timestamp instanceof Date
          ? lastMessage.timestamp.toISOString()
          : undefined

  return {
    latestSummary: lastAssistantMessage
      ? summarizeText(
          typeof lastAssistantMessage.content === 'string'
            ? lastAssistantMessage.content
            : Array.isArray(lastAssistantMessage.content)
              ? extractTextContent(lastAssistantMessage.content, '\n')
              : '',
          180,
          '',
        )
      : undefined,
    lastActivity,
  }
}

export function parseAoArgs(args: string): ParsedAoArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const [actionRaw = 'help', targetRaw, idRaw, ...extra] = tokens
  const action = actionRaw.toLowerCase()

  if (action === 'help' || action.length === 0) {
    return { action: 'help' }
  }

  if (action === 'list') {
    if (!targetRaw) {
      return { action: 'list', target: 'all' }
    }

    const target = normalizeTarget(targetRaw)
    if (!target || extra.length > 0 || idRaw) {
      return {
        action: 'help',
        error: 'Usage: /ao list [cron|plan]',
      }
    }

    return { action: 'list', target }
  }

  if (action === 'status' || action === 'run') {
    const target = normalizeTarget(targetRaw)
    const id = typeof idRaw === 'string' ? idRaw.trim() : ''
    if (!target || !id || extra.length > 0) {
      return {
        action: 'help',
        error: `Usage: /ao ${action} <cron|plan> <id>`,
      }
    }

    return { action, target, id }
  }

  return {
    action: 'help',
    error: `Unknown /ao action: ${action}`,
  }
}

export function formatAoUsage(): string {
  return [
    '# Always-On',
    '',
    'Usage:',
    '- /ao list [cron|plan]',
    '- /ao status <cron|plan> <id>',
    '- /ao run <cron|plan> <id>',
    '- /ao help',
  ].join('\n')
}

export async function listAoCronJobs(
  taskStatusesByCronTaskId: Map<string, string> = new Map(),
): Promise<AoCronOverview[]> {
  const [tasks, runtimeTasks] = await Promise.all([
    listAllCronTasks(),
    listRuntimeCronTasks(),
  ])
  const allTasks = mergeAoCronTasksById(tasks, runtimeTasks)

  const jobs = await Promise.all(
    allTasks.map(async task => {
      const runtimeTask = runtimeTasks.get(task.id)
      const inProcessStatus = normalizeTaskStatus(
        taskStatusesByCronTaskId.get(task.id),
      )
      const transcriptSummary = await readCronTranscriptSummary(task)
      const status: AoCronStatus =
        runtimeTask?.running || inProcessStatus === 'running'
          ? 'running'
          : inProcessStatus
            ? inProcessStatus
            : task.transcriptKey
              ? 'unknown'
              : 'scheduled'

      return {
        ...task,
        status,
        latestSummary: transcriptSummary.latestSummary,
        lastActivity: transcriptSummary.lastActivity,
      }
    }),
  )

  return jobs.sort((left, right) => right.createdAt - left.createdAt)
}

export async function getAoCronJobStatus(
  id: string,
  taskStatusesByCronTaskId: Map<string, string> = new Map(),
): Promise<AoCronOverview | null> {
  const jobs = await listAoCronJobs(taskStatusesByCronTaskId)
  return jobs.find(job => job.id === id) ?? null
}

export async function runAoCronJob(id: string): Promise<{
  started: boolean
  reason?: 'already_running' | 'not_found'
}> {
  const response = await requestCronDaemon({
    type: 'run_task_now',
    projectRoot: getProjectRoot(),
    taskId: id,
  })
  assertCronDaemonOk(response)
  if (response.data.type !== 'run_task_now') {
    throw new Error('Unexpected Cron daemon run-now response')
  }

  return {
    started: response.data.started,
    ...(response.data.reason ? { reason: response.data.reason } : {}),
  }
}

export async function listAoDiscoveryPlans(): Promise<DiscoveryPlanRecord[]> {
  const index = await readDiscoveryPlanIndex()
  return [...index.plans].sort((left, right) => {
    const leftOrder = DISCOVERY_PLAN_STATUS_ORDER[getDiscoveryPlanStatus(left)] ?? 99
    const rightOrder = DISCOVERY_PLAN_STATUS_ORDER[getDiscoveryPlanStatus(right)] ?? 99
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder
    }

    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  })
}

export async function getAoDiscoveryPlan(
  id: string,
): Promise<DiscoveryPlanRecord | null> {
  const index = await readDiscoveryPlanIndex()
  return index.plans.find(plan => plan.id === id) ?? null
}

export function buildAoDiscoveryPlanExecutionPrompt(
  plan: DiscoveryPlanRecord,
  planContent: string,
  projectRoot = getProjectRoot(),
): string {
  const projectLabel = basename(projectRoot) || projectRoot

  return [
    `Always-On execution for project "${projectLabel}".`,
    '',
    'This plan is ready for execution.',
    'Execute the work directly.',
    'Do not enter Plan Mode.',
    'Do not create a second mini-plan before acting.',
    '',
    `Plan ID: ${plan.id}`,
    `Plan file: ${plan.planFilePath}`,
    '',
    'Approved plan:',
    '',
    planContent.trim(),
  ].join('\n')
}

export async function prepareAoDiscoveryPlanExecution(
  id: string,
  options: {
    executionSessionId?: string
    projectRoot?: string
  } = {},
): Promise<{
  plan: DiscoveryPlanRecord
  prompt: string
  content: string
}> {
  const projectRoot = options.projectRoot ?? getProjectRoot()
  const executionSessionId = options.executionSessionId ?? getSessionId()
  const index = await readDiscoveryPlanIndex(projectRoot)
  const planIndex = index.plans.findIndex(plan => plan.id === id)
  if (planIndex === -1) {
    throw new Error('Discovery plan not found')
  }

  const currentPlan = index.plans[planIndex]!
  const currentStatus = getDiscoveryPlanStatus(currentPlan)
  if (currentStatus === 'queued' || currentStatus === 'running') {
    throw new Error('Discovery plan is already queued or running')
  }
  if (currentStatus === 'superseded') {
    throw new Error('Superseded discovery plans cannot be executed')
  }

  const content = await readDiscoveryPlanContent(currentPlan.planFilePath, projectRoot)
  if (!content.trim()) {
    throw new Error('Discovery plan content is missing')
  }

  const now = new Date().toISOString()
  const nextPlan: DiscoveryPlanRecord = {
    ...currentPlan,
    status: 'running',
    executionStatus: 'running',
    executionSessionId,
    executionStartedAt: now,
    executionLastActivityAt: now,
    latestSummary: '',
    updatedAt: now,
  }
  index.plans[planIndex] = nextPlan
  await writeDiscoveryPlanIndex(index, projectRoot)

  return {
    plan: nextPlan,
    content,
    prompt: buildAoDiscoveryPlanExecutionPrompt(nextPlan, content, projectRoot),
  }
}

export function formatAoCronList(jobs: AoCronOverview[]): string {
  const lines = [
    `## Cron jobs (${jobs.length})`,
    '',
  ]

  if (jobs.length === 0) {
    lines.push('No cron jobs found.')
    return lines.join('\n')
  }

  for (const job of jobs) {
    const kind = [
      job.durable === false ? 'session' : 'durable',
      job.recurring ? 'recurring' : 'one-shot',
      job.manualOnly ? 'manual-only' : null,
    ].filter(Boolean).join(', ')

    lines.push(`- ${job.id} - ${summarizeText(job.prompt)}`)
    lines.push(`  - Status: ${job.status}`)
    lines.push(`  - Kind: ${kind}`)
    lines.push(`  - Schedule: ${job.cron}`)
    lines.push(`  - Last fired: ${formatDateTime(job.lastFiredAt)}`)
    if (job.latestSummary) {
      lines.push(`  - Latest summary: ${job.latestSummary}`)
    }
  }

  return lines.join('\n')
}

export function formatAoCronStatus(job: AoCronOverview): string {
  return [
    `# Cron job ${job.id}`,
    '',
    `- Status: ${job.status}`,
    `- Schedule: ${job.cron}`,
    `- Scope: ${job.durable === false ? 'session' : 'durable'}`,
    `- Type: ${job.recurring ? 'recurring' : 'one-shot'}`,
    `- Manual only: ${job.manualOnly ? 'yes' : 'no'}`,
    `- Created: ${formatDateTime(job.createdAt)}`,
    `- Last fired: ${formatDateTime(job.lastFiredAt)}`,
    `- Origin session: ${normalizeText(job.originSessionId)}`,
    `- Transcript key: ${normalizeText(job.transcriptKey)}`,
    `- Last activity: ${formatDateTime(job.lastActivity)}`,
    '',
    '## Prompt',
    '',
    normalizeText(job.prompt),
    '',
    '## Latest summary',
    '',
    normalizeText(job.latestSummary),
  ].join('\n')
}

export function formatAoCronRunResult(
  id: string,
  result: { started: boolean; reason?: 'already_running' | 'not_found' },
): string {
  if (result.reason === 'not_found') {
    return `No cron job found with id ${id}.`
  }

  if (result.reason === 'already_running' || result.started === false) {
    return `Cron job ${id} is already running.`
  }

  return `Started cron job ${id} immediately.`
}

export function formatAoDiscoveryPlanList(
  plans: DiscoveryPlanRecord[],
): string {
  const lines = [
    `## Discovery plans (${plans.length})`,
    '',
  ]

  if (plans.length === 0) {
    lines.push('No discovery plans found.')
    return lines.join('\n')
  }

  for (const plan of plans) {
    lines.push(`- ${plan.id} - ${normalizeText(plan.title)}`)
    lines.push(`  - Status: ${getDiscoveryPlanStatus(plan)}`)
    lines.push(`  - Updated: ${formatDateTime(plan.updatedAt)}`)
    lines.push(`  - Summary: ${summarizeText(plan.summary, 180)}`)
  }

  return lines.join('\n')
}

export function formatAoDiscoveryPlanStatus(
  plan: DiscoveryPlanRecord,
): string {
  return [
    `# Discovery plan ${plan.id}`,
    '',
    `- Title: ${normalizeText(plan.title)}`,
    `- Status: ${getDiscoveryPlanStatus(plan)}`,
    `- Updated: ${formatDateTime(plan.updatedAt)}`,
    `- Execution session: ${normalizeText(plan.executionSessionId)}`,
    `- Execution started: ${formatDateTime(plan.executionStartedAt)}`,
    `- Last activity: ${formatDateTime(plan.executionLastActivityAt)}`,
    `- Plan file: ${normalizeText(plan.planFilePath)}`,
    '',
    '## Summary',
    '',
    normalizeText(plan.summary),
    '',
    '## Rationale',
    '',
    normalizeText(plan.rationale),
    '',
    '## Latest summary',
    '',
    normalizeText(plan.latestSummary),
  ].join('\n')
}

export function formatAoCombinedList(args: {
  jobs: AoCronOverview[]
  plans: DiscoveryPlanRecord[]
}): string {
  return [
    '# Always-On',
    '',
    formatAoDiscoveryPlanList(args.plans),
    '',
    formatAoCronList(args.jobs),
  ].join('\n')
}
