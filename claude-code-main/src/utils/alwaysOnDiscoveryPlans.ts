import { randomUUID } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { getProjectRoot, getSessionId } from '../bootstrap/state.js'
import { isENOENT } from './errors.js'
import { safeParseJSON } from './json.js'
import { generateWordSlug } from './words.js'

export const ALWAYS_ON_DISCOVERY_STRUCTURE_VERSION = 1
export const ALWAYS_ON_DISCOVERY_INDEX_VERSION = 1

export const REQUIRED_DISCOVERY_PLAN_SECTIONS = [
  '## Context',
  '## Signals Reviewed',
  '## Proposed Work',
  '## Execution Steps',
  '## Verification',
  '## To-Do List',
] as const

export type DiscoveryPlanStatus =
  | 'draft'
  | 'ready'
  | 'queued'
  | 'running'
  | 'apply_pending'
  | 'apply_queued'
  | 'apply_running'
  | 'apply_failed'
  | 'completed'
  | 'failed'
  | 'superseded'

export type DiscoveryPlanContextRefs = {
  workingDirectory: string[]
  memory: string[]
  existingPlans: string[]
  cronJobs: string[]
  recentChats: string[]
}

export type DiscoveryPlanRecord = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  status: DiscoveryPlanStatus
  summary: string
  rationale: string
  dedupeKey: string
  sourceDiscoverySessionId: string
  executionSessionId?: string
  executionRunId?: string
  executionQueuedAt?: string
  executionStartedAt?: string
  executionLastActivityAt?: string
  executionStatus?: 'queued' | 'running' | 'completed' | 'failed'
  executionFailureReason?: string
  executionWorkspaceKind?: 'git-worktree' | 'snapshot-git-mirror' | 'mirror'
  executionWorkspacePath?: string
  executionRunDir?: string
  mirrorStrategy?: Record<string, unknown>
  applyStatus?: 'pending' | 'queued' | 'running' | 'applied' | 'failed' | 'needs_review'
  reportFilePath?: string
  changesPatchPath?: string
  fileOpsPath?: string
  latestSummary?: string
  contextRefs: DiscoveryPlanContextRefs
  planFilePath: string
  structureVersion: number
}

export type DiscoveryPlanIndex = {
  version: number
  plans: DiscoveryPlanRecord[]
}

export type DiscoveryPlanInput = {
  id?: string
  title: string
  summary: string
  rationale: string
  dedupeKey: string
  content: string
  contextRefs?: Partial<DiscoveryPlanContextRefs>
  supersedesPlanIds?: string[]
}

function normalizeText(value: string | undefined): string {
  if (typeof value !== 'string') {
    return ''
  }

  return value.replace(/\r\n/g, '\n').trim()
}

function normalizeContextRefs(
  input: Partial<DiscoveryPlanContextRefs> | undefined,
): DiscoveryPlanContextRefs {
  const normalizeItems = (value: string[] | undefined): string[] =>
    Array.isArray(value)
      ? value
          .filter(item => typeof item === 'string')
          .map(item => item.trim())
          .filter(Boolean)
      : []

  return {
    workingDirectory: normalizeItems(input?.workingDirectory),
    memory: normalizeItems(input?.memory),
    existingPlans: normalizeItems(input?.existingPlans),
    cronJobs: normalizeItems(input?.cronJobs),
    recentChats: normalizeItems(input?.recentChats),
  }
}

function isValidMarkdownDiscoveryPlan(content: string): boolean {
  const normalized = normalizeText(content).toLowerCase()
  if (!normalized) {
    return false
  }

  return REQUIRED_DISCOVERY_PLAN_SECTIONS.every(section =>
    normalized.includes(section.toLowerCase()),
  )
}

function getAlwaysOnRoot(projectRoot = getProjectRoot()): string {
  return join(projectRoot, '.claude', 'always-on')
}

function getDiscoveryPlanMarkdownDirectory(projectRoot = getProjectRoot()): string {
  return join(getAlwaysOnRoot(projectRoot), 'plans')
}

export function getDiscoveryPlanIndexPath(projectRoot = getProjectRoot()): string {
  return join(getAlwaysOnRoot(projectRoot), 'discovery-plans.json')
}

export function getDiscoveryPlanMarkdownPath(
  planId: string,
  projectRoot = getProjectRoot(),
): string {
  return join(getDiscoveryPlanMarkdownDirectory(projectRoot), `${planId}.md`)
}

function getRelativePlanMarkdownPath(planId: string): string {
  return join('.claude', 'always-on', 'plans', `${planId}.md`)
}

async function ensureDiscoveryPlanDirectories(projectRoot = getProjectRoot()) {
  await mkdir(getDiscoveryPlanMarkdownDirectory(projectRoot), { recursive: true })
}

export async function readDiscoveryPlanIndex(
  projectRoot = getProjectRoot(),
): Promise<DiscoveryPlanIndex> {
  try {
    const raw = await readFile(getDiscoveryPlanIndexPath(projectRoot), 'utf8')
    const parsed = safeParseJSON(raw, false)
    if (
      parsed &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as DiscoveryPlanIndex).plans)
    ) {
      return {
        version:
          typeof (parsed as DiscoveryPlanIndex).version === 'number'
            ? (parsed as DiscoveryPlanIndex).version
            : ALWAYS_ON_DISCOVERY_INDEX_VERSION,
        plans: (parsed as DiscoveryPlanIndex).plans,
      }
    }
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }

  return {
    version: ALWAYS_ON_DISCOVERY_INDEX_VERSION,
    plans: [],
  }
}

export async function readDiscoveryPlanContent(
  planFilePath: string,
  projectRoot = getProjectRoot(),
): Promise<string> {
  const resolvedPath = resolve(projectRoot, planFilePath)
  try {
    return await readFile(resolvedPath, 'utf8')
  } catch (error) {
    if (isENOENT(error)) {
      return ''
    }
    throw error
  }
}

export async function writeDiscoveryPlanIndex(
  index: DiscoveryPlanIndex,
  projectRoot = getProjectRoot(),
): Promise<void> {
  await ensureDiscoveryPlanDirectories(projectRoot)
  const plans = index.plans.map(plan => {
    const { approvalMode: _approvalMode, ...rest } = plan as DiscoveryPlanRecord & {
      approvalMode?: unknown
    }
    void _approvalMode
    return rest
  })
  await writeFile(
    getDiscoveryPlanIndexPath(projectRoot),
    `${JSON.stringify({ ...index, plans }, null, 2)}\n`,
    'utf8',
  )
}

async function writeDiscoveryPlanContent(
  planId: string,
  content: string,
  projectRoot = getProjectRoot(),
): Promise<string> {
  await ensureDiscoveryPlanDirectories(projectRoot)
  const normalizedContent = normalizeText(content)
  const absolutePath = getDiscoveryPlanMarkdownPath(planId, projectRoot)
  await writeFile(absolutePath, `${normalizedContent}\n`, 'utf8')
  return getRelativePlanMarkdownPath(planId)
}

async function generateDiscoveryPlanId(projectRoot = getProjectRoot()): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const slug = generateWordSlug()
    try {
      await readFile(getDiscoveryPlanMarkdownPath(slug, projectRoot), 'utf8')
    } catch (error) {
      if (isENOENT(error)) {
        return slug
      }
      throw error
    }
  }

  return `plan-${randomUUID().slice(0, 8)}`
}

function mergeSupersededPlanIds(inputs: DiscoveryPlanInput[]): Set<string> {
  const ids = new Set<string>()
  for (const input of inputs) {
    for (const planId of input.supersedesPlanIds ?? []) {
      if (typeof planId === 'string' && planId.trim().length > 0) {
        ids.add(planId.trim())
      }
    }
  }
  return ids
}

export async function upsertDiscoveryPlans(
  inputs: DiscoveryPlanInput[],
  projectRoot = getProjectRoot(),
): Promise<DiscoveryPlanRecord[]> {
  if (inputs.length === 0) {
    return []
  }

  const sourceDiscoverySessionId = getSessionId()
  const now = new Date().toISOString()
  const index = await readDiscoveryPlanIndex(projectRoot)
  const savedPlans: DiscoveryPlanRecord[] = []

  for (const input of inputs) {
    const requestedPlanId = normalizeText(input.id) || undefined
    const title = normalizeText(input.title)
    const summary = normalizeText(input.summary)
    const rationale = normalizeText(input.rationale)
    const dedupeKey = normalizeText(input.dedupeKey)
    const content = normalizeText(input.content)

    if (!title || !summary || !rationale || !dedupeKey) {
      throw new Error(
        'Discovery plan title, summary, rationale, and dedupeKey are required.',
      )
    }
    if (!isValidMarkdownDiscoveryPlan(content)) {
      throw new Error(
        `Discovery plan markdown must include these sections: ${REQUIRED_DISCOVERY_PLAN_SECTIONS.join(', ')}`,
      )
    }

    const existingIndex = requestedPlanId
      ? index.plans.findIndex(plan => plan.id === requestedPlanId)
      : index.plans.findIndex(
          plan =>
            plan.sourceDiscoverySessionId === sourceDiscoverySessionId &&
            plan.dedupeKey === dedupeKey,
        )

    const existingPlan =
      existingIndex >= 0 ? index.plans[existingIndex] : null
    const planId = existingPlan?.id ?? requestedPlanId ?? (await generateDiscoveryPlanId(projectRoot))
    const planFilePath = await writeDiscoveryPlanContent(planId, content, projectRoot)

    const nextPlan: DiscoveryPlanRecord = {
      id: planId,
      title,
      createdAt: existingPlan?.createdAt ?? now,
      updatedAt: now,
      status:
        existingPlan?.status &&
        ['queued', 'running', 'completed', 'failed'].includes(existingPlan.status)
          ? existingPlan.status
          : 'ready',
      summary,
      rationale,
      dedupeKey,
      sourceDiscoverySessionId,
      executionSessionId: existingPlan?.executionSessionId,
      executionRunId: existingPlan?.executionRunId,
      executionQueuedAt: existingPlan?.executionQueuedAt,
      executionStartedAt: existingPlan?.executionStartedAt,
      executionLastActivityAt: existingPlan?.executionLastActivityAt,
      executionStatus: existingPlan?.executionStatus,
      executionFailureReason: existingPlan?.executionFailureReason,
      executionWorkspaceKind: existingPlan?.executionWorkspaceKind,
      executionWorkspacePath: existingPlan?.executionWorkspacePath,
      executionRunDir: existingPlan?.executionRunDir,
      mirrorStrategy: existingPlan?.mirrorStrategy,
      applyStatus: existingPlan?.applyStatus,
      reportFilePath: existingPlan?.reportFilePath,
      changesPatchPath: existingPlan?.changesPatchPath,
      fileOpsPath: existingPlan?.fileOpsPath,
      latestSummary: existingPlan?.latestSummary,
      contextRefs: normalizeContextRefs(input.contextRefs),
      planFilePath,
      structureVersion: ALWAYS_ON_DISCOVERY_STRUCTURE_VERSION,
    }

    if (existingIndex >= 0) {
      index.plans[existingIndex] = nextPlan
    } else {
      index.plans.push(nextPlan)
    }

    savedPlans.push(nextPlan)
  }

  const supersededPlanIds = mergeSupersededPlanIds(inputs)
  if (supersededPlanIds.size > 0) {
    index.plans = index.plans.map(plan =>
      supersededPlanIds.has(plan.id)
        ? {
            ...plan,
            status:
              plan.executionStatus === 'running' || plan.executionStatus === 'completed'
                ? plan.status
                : 'superseded',
            updatedAt: now,
          }
        : plan,
    )
  }

  await writeDiscoveryPlanIndex(index, projectRoot)
  return savedPlans.map(plan => {
    const persisted = index.plans.find(candidate => candidate.id === plan.id)
    return persisted ?? plan
  })
}
