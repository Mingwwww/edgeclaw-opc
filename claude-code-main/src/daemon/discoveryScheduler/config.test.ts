import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DISCOVERY_TRIGGER_CONFIG,
  resolveDiscoveryTriggerConfig,
} from './config.js'

describe('getDiscoveryTriggerConfig', () => {
  test('defaults to disabled with safe budget and timing values', () => {
    expect(resolveDiscoveryTriggerConfig({})).toEqual(DEFAULT_DISCOVERY_TRIGGER_CONFIG)
  })

  test('reads valid AlwaysOn discovery trigger config', () => {
    const rawConfig = {
      agents: {
        alwaysOn: {
          discovery: {
            trigger: {
              enabled: true,
              tickIntervalMinutes: 1,
              cooldownMinutes: 15,
              dailyBudget: 2,
              heartbeatStaleSeconds: 30,
              recentUserMsgMinutes: 3,
              preferClient: 'tui',
            },
          },
        },
      },
    }

    expect(resolveDiscoveryTriggerConfig(rawConfig)).toEqual({
      enabled: true,
      tickIntervalMinutes: 1,
      cooldownMinutes: 15,
      dailyBudget: 2,
      heartbeatStaleSeconds: 30,
      recentUserMsgMinutes: 3,
      preferClient: 'tui',
    })
  })

  test('falls back for non-positive numeric values', () => {
    const rawConfig = {
      agents: {
        alwaysOn: {
          discovery: {
            trigger: {
              enabled: true,
              tickIntervalMinutes: 0,
              cooldownMinutes: -1,
              dailyBudget: Number.NaN,
              heartbeatStaleSeconds: Number.POSITIVE_INFINITY,
              recentUserMsgMinutes: 'soon',
            },
          },
        },
      },
    }

    expect(resolveDiscoveryTriggerConfig(rawConfig)).toEqual({
      ...DEFAULT_DISCOVERY_TRIGGER_CONFIG,
      enabled: true,
    })
  })

  test('falls back to Web UI for unknown preferred client values', () => {
    const rawConfig = {
      agents: {
        alwaysOn: {
          discovery: {
            trigger: {
              enabled: true,
              preferClient: 'desktop',
            },
          },
        },
      },
    }

    expect(resolveDiscoveryTriggerConfig(rawConfig).preferClient).toBe('webui')
  })
})
