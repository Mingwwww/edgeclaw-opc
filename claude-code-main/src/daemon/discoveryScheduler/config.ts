import { resolve } from 'path'
import { loadEdgeClawConfig } from '../../../edgeclaw-config.js'
import type { DiscoveryTriggerConfig } from './types.js'

export const DEFAULT_DISCOVERY_TRIGGER_CONFIG: DiscoveryTriggerConfig = {
  enabled: false,
  tickIntervalMinutes: 5,
  cooldownMinutes: 60,
  dailyBudget: 4,
  heartbeatStaleSeconds: 90,
  recentUserMsgMinutes: 5,
  preferClient: 'webui',
  projectSettings: {},
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function readProjectSettings(value: unknown): DiscoveryTriggerConfig['projectSettings'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const settings: DiscoveryTriggerConfig['projectSettings'] = {}
  for (const [projectRoot, rawSettings] of Object.entries(value)) {
    if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
      continue
    }
    settings[resolve(projectRoot)] = {
      enabled:
        typeof rawSettings === 'object' &&
        rawSettings !== null &&
        (rawSettings as { enabled?: unknown }).enabled === true,
    }
  }
  return settings
}

export function getDiscoveryTriggerConfig(): DiscoveryTriggerConfig {
  const discovery = (loadEdgeClawConfig() as any).alwaysOn?.discovery
  const raw = discovery?.trigger
  const preferClient = raw?.preferClient === 'tui' ? 'tui' : 'webui'

  return {
    enabled: raw?.enabled === true,
    tickIntervalMinutes: positiveNumber(
      raw?.tickIntervalMinutes,
      DEFAULT_DISCOVERY_TRIGGER_CONFIG.tickIntervalMinutes,
    ),
    cooldownMinutes: positiveNumber(
      raw?.cooldownMinutes,
      DEFAULT_DISCOVERY_TRIGGER_CONFIG.cooldownMinutes,
    ),
    dailyBudget: positiveNumber(
      raw?.dailyBudget,
      DEFAULT_DISCOVERY_TRIGGER_CONFIG.dailyBudget,
    ),
    heartbeatStaleSeconds: positiveNumber(
      raw?.heartbeatStaleSeconds,
      DEFAULT_DISCOVERY_TRIGGER_CONFIG.heartbeatStaleSeconds,
    ),
    recentUserMsgMinutes: positiveNumber(
      raw?.recentUserMsgMinutes,
      DEFAULT_DISCOVERY_TRIGGER_CONFIG.recentUserMsgMinutes,
    ),
    preferClient,
    projectSettings: readProjectSettings(discovery?.projects),
  }
}
