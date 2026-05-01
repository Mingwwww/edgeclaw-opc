import { access } from 'fs/promises'
import { resolve } from 'path'
import { hasBusyHeartbeat, hasRecentUserMessage, readFreshHeartbeats } from './heartbeats.js'
import { acquireDiscoveryLock } from './lock.js'
import { readDiscoveryState } from './state.js'
import type {
  AlwaysOnHeartbeat,
  DiscoveryTriggerConfig,
  GateResult,
} from './types.js'

function sortByPreferredClient(
  heartbeats: AlwaysOnHeartbeat[],
  preferClient: DiscoveryTriggerConfig['preferClient'],
): AlwaysOnHeartbeat[] {
  return [...heartbeats].sort((left, right) => {
    if (left.writerKind === right.writerKind) {
      return right.writtenAt.localeCompare(left.writtenAt)
    }
    return left.writerKind === preferClient ? -1 : 1
  })
}

export async function evaluateDiscoveryGates(
  projectRoot: string,
  config: DiscoveryTriggerConfig,
  now = new Date(),
): Promise<GateResult> {
  if (!config.enabled) {
    return { ok: false, reason: 'disabled' }
  }

  if (config.projectSettings[resolve(projectRoot)]?.enabled !== true) {
    return { ok: false, reason: 'project_disabled' }
  }

  try {
    await access(projectRoot)
  } catch {
    return { ok: false, reason: 'project_missing' }
  }

  const heartbeats = await readFreshHeartbeats(
    projectRoot,
    config.heartbeatStaleSeconds,
    now,
  )
  if (heartbeats.length === 0) {
    return { ok: false, reason: 'no_fresh_heartbeat' }
  }
  if (hasBusyHeartbeat(heartbeats)) {
    return { ok: false, reason: 'agent_busy' }
  }
  if (hasRecentUserMessage(heartbeats, config.recentUserMsgMinutes, now)) {
    return { ok: false, reason: 'recent_user_msg' }
  }

  const state = await readDiscoveryState(projectRoot, now)
  if (state.lastFireCompletedAt) {
    const completedAt = Date.parse(state.lastFireCompletedAt)
    if (
      Number.isFinite(completedAt) &&
      now.getTime() - completedAt < config.cooldownMinutes * 60_000
    ) {
      return { ok: false, reason: 'cooldown' }
    }
  }
  if (state.todayRunCount >= config.dailyBudget) {
    return { ok: false, reason: 'daily_budget' }
  }

  if (!(await acquireDiscoveryLock(projectRoot))) {
    return { ok: false, reason: 'lock_busy' }
  }

  return {
    ok: true,
    heartbeat: sortByPreferredClient(heartbeats, config.preferClient)[0]!,
  }
}
