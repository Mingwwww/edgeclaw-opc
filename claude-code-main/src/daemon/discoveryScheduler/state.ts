import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { getAlwaysOnDiscoveryStatePath } from '../../utils/alwaysOnPaths.js'
import { safeParseJSON } from '../../utils/json.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { DiscoveryState } from './types.js'

function todayLocalDate(): string {
  const now = new Date()
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function createDefaultDiscoveryState(): DiscoveryState {
  return {
    schemaVersion: 1,
    lastFireStartedAt: null,
    lastFireCompletedAt: null,
    lastFireResult: null,
    consecutiveNoPlanRuns: 0,
    todayRunCount: 0,
    todayRunDate: todayLocalDate(),
  }
}

function normalizeState(value: unknown): DiscoveryState {
  if (!value || typeof value !== 'object') {
    return createDefaultDiscoveryState()
  }
  const input = value as Partial<DiscoveryState>
  const today = todayLocalDate()
  return {
    schemaVersion: 1,
    lastFireStartedAt:
      typeof input.lastFireStartedAt === 'string'
        ? input.lastFireStartedAt
        : null,
    lastFireCompletedAt:
      typeof input.lastFireCompletedAt === 'string'
        ? input.lastFireCompletedAt
        : null,
    lastFireResult:
      input.lastFireResult === 'started' || input.lastFireResult === 'failed'
        ? input.lastFireResult
        : null,
    consecutiveNoPlanRuns:
      typeof input.consecutiveNoPlanRuns === 'number' &&
      Number.isFinite(input.consecutiveNoPlanRuns) &&
      input.consecutiveNoPlanRuns >= 0
        ? input.consecutiveNoPlanRuns
        : 0,
    todayRunCount:
      input.todayRunDate === today &&
      typeof input.todayRunCount === 'number' &&
      Number.isFinite(input.todayRunCount) &&
      input.todayRunCount >= 0
        ? input.todayRunCount
        : 0,
    todayRunDate: today,
  }
}

export async function readDiscoveryState(
  projectRoot: string,
): Promise<DiscoveryState> {
  try {
    const raw = await readFile(getAlwaysOnDiscoveryStatePath(projectRoot), 'utf-8')
    return normalizeState(safeParseJSON(raw, false))
  } catch {
    return createDefaultDiscoveryState()
  }
}

export async function writeDiscoveryState(
  projectRoot: string,
  state: DiscoveryState,
): Promise<void> {
  const path = getAlwaysOnDiscoveryStatePath(projectRoot)
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tempPath, jsonStringify(state, null, 2) + '\n', 'utf-8')
  await rename(tempPath, path)
}

export async function markDiscoveryFireStarted(
  projectRoot: string,
): Promise<DiscoveryState> {
  const state = await readDiscoveryState(projectRoot)
  const next: DiscoveryState = {
    ...state,
    lastFireStartedAt: new Date().toISOString(),
  }
  await writeDiscoveryState(projectRoot, next)
  return next
}

export async function markDiscoveryFireCompleted(
  projectRoot: string,
  result: 'started' | 'failed',
): Promise<DiscoveryState> {
  const state = await readDiscoveryState(projectRoot)
  const today = todayLocalDate()
  const next: DiscoveryState = {
    ...state,
    lastFireCompletedAt: new Date().toISOString(),
    lastFireResult: result,
    consecutiveNoPlanRuns:
      result === 'failed' ? state.consecutiveNoPlanRuns + 1 : 0,
    todayRunDate: today,
    todayRunCount:
      state.todayRunDate === today ? state.todayRunCount + 1 : 1,
  }
  await writeDiscoveryState(projectRoot, next)
  return next
}
