import { access } from 'fs/promises'
import type { AlwaysOnDiscoveryTriggerConfig, DiscoveryGateResult } from './types.js'
import {
  hasBusyHeartbeat,
  hasRecentUserMessage,
  readFreshDiscoveryHeartbeats,
} from './heartbeats.js'
import { readDiscoveryState } from './state.js'
import { tryAcquireDiscoveryLock } from './lock.js'

function blocked(
  blockedAt: 0 | 1 | 2 | 3,
  reason: string,
): DiscoveryGateResult {
  return { fire: false, blockedAt, reason }
}

function timestampMs(value: string | null): number | null {
  if (!value) {
    return null
  }
  const timestamp = new Date(value).getTime()
  return Number.isFinite(timestamp) ? timestamp : null
}

export async function evaluateDiscoveryGates(
  projectRoot: string,
  config: AlwaysOnDiscoveryTriggerConfig,
): Promise<DiscoveryGateResult> {
  if (!config.enabled) {
    return blocked(0, 'disabled')
  }
  try {
    await access(projectRoot)
  } catch {
    return blocked(0, 'project_root_missing')
  }

  const staleMs = config.heartbeatStaleSeconds * 1000
  const heartbeats = await readFreshDiscoveryHeartbeats(projectRoot, staleMs)
  if (heartbeats.length === 0) {
    return blocked(0, 'no_client_online')
  }
  if (hasBusyHeartbeat(heartbeats)) {
    return blocked(1, 'agent_busy')
  }
  if (hasRecentUserMessage(heartbeats, config.recentUserMsgMinutes * 60_000)) {
    return blocked(1, 'recent_user_msg')
  }

  const state = await readDiscoveryState(projectRoot)
  const lastCompletedAt = timestampMs(state.lastFireCompletedAt)
  if (lastCompletedAt !== null) {
    const cooldownMs =
      config.cooldownMinutes *
      60_000 *
      Math.max(1, 1 + state.consecutiveNoPlanRuns)
    if (Date.now() - lastCompletedAt < cooldownMs) {
      return blocked(2, 'cooldown')
    }
  }
  if (state.todayRunCount >= config.dailyBudget) {
    return blocked(2, 'daily_budget')
  }

  const lockHandle = await tryAcquireDiscoveryLock(projectRoot)
  if (!lockHandle) {
    return blocked(3, 'locked')
  }

  const preferred =
    heartbeats.find(
      heartbeat => heartbeat.body.writerKind === config.preferClient,
    ) ?? heartbeats[0]!

  return { fire: true, lockHandle, target: preferred }
}
