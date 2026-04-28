import { loadEdgeClawConfig } from '../../../edgeclaw-config'
import { isEnvTruthy } from '../../utils/envUtils.js'
import type { AlwaysOnDiscoveryTriggerConfig } from './types.js'

const DEFAULT_CONFIG: AlwaysOnDiscoveryTriggerConfig = {
  enabled: false,
  tickIntervalMinutes: 5,
  cooldownMinutes: 60,
  dailyBudget: 4,
  heartbeatStaleSeconds: 90,
  recentUserMsgMinutes: 5,
  preferClient: 'webui',
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

export function loadDiscoveryTriggerConfig(): AlwaysOnDiscoveryTriggerConfig {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_CRON)) {
    return { ...DEFAULT_CONFIG, enabled: false }
  }

  const config = loadEdgeClawConfig()
  const raw = (config.agents as any)?.alwaysOn?.discovery?.trigger ?? {}

  return {
    enabled: raw.enabled === true,
    tickIntervalMinutes: positiveNumber(
      raw.tickIntervalMinutes,
      DEFAULT_CONFIG.tickIntervalMinutes,
    ),
    cooldownMinutes: positiveNumber(
      raw.cooldownMinutes,
      DEFAULT_CONFIG.cooldownMinutes,
    ),
    dailyBudget: positiveNumber(raw.dailyBudget, DEFAULT_CONFIG.dailyBudget),
    heartbeatStaleSeconds: positiveNumber(
      raw.heartbeatStaleSeconds,
      DEFAULT_CONFIG.heartbeatStaleSeconds,
    ),
    recentUserMsgMinutes: positiveNumber(
      raw.recentUserMsgMinutes,
      DEFAULT_CONFIG.recentUserMsgMinutes,
    ),
    preferClient: raw.preferClient === 'tui' ? 'tui' : 'webui',
  }
}
