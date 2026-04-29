import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { evaluateDiscoveryGates } from './gates.js'
import { DEFAULT_DISCOVERY_TRIGGER_CONFIG } from './config.js'
import { acquireDiscoveryLock, releaseDiscoveryLock } from './lock.js'
import {
  getAlwaysOnDiscoveryStatePath,
  getAlwaysOnHeartbeatsDir,
  getAlwaysOnHeartbeatPath,
} from '../../utils/alwaysOnPaths.js'

const config = {
  ...DEFAULT_DISCOVERY_TRIGGER_CONFIG,
  enabled: true,
  cooldownMinutes: 60,
  dailyBudget: 4,
  heartbeatStaleSeconds: 90,
  recentUserMsgMinutes: 5,
}

describe('always-on discovery gates', () => {
  let projectRoot: string

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'always-on-gates-'))
    await mkdir(getAlwaysOnHeartbeatsDir(projectRoot), { recursive: true })
  })

  async function writeBeat(overrides: Record<string, unknown> = {}) {
    await writeFile(
      getAlwaysOnHeartbeatPath(projectRoot, `${overrides.writerId || 'webui'}.beat`),
      JSON.stringify({
        schemaVersion: 1,
        writerKind: 'webui',
        writerId: 'webui',
        writtenAt: '2026-04-29T00:00:00.000Z',
        agentBusy: false,
        processingSessionIds: [],
        lastUserMsgAt: null,
        ...overrides,
      }),
    )
  }

  async function writeState(overrides: Record<string, unknown>) {
    await writeFile(
      getAlwaysOnDiscoveryStatePath(projectRoot),
      JSON.stringify({
        schemaVersion: 1,
        todayKey: '2026-04-29',
        todayRunCount: 0,
        consecutiveFailures: 0,
        ...overrides,
      }),
    )
  }

  test('blocks when discovery triggers are disabled', async () => {
    await writeBeat()

    const result = await evaluateDiscoveryGates(
      projectRoot,
      { ...config, enabled: false },
      new Date('2026-04-29T00:00:30.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'disabled' })
  })

  test('blocks when the project root no longer exists', async () => {
    const result = await evaluateDiscoveryGates(
      join(tmpdir(), 'always-on-missing-project-root'),
      config,
      new Date('2026-04-29T00:00:30.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'project_missing' })
  })

  test('blocks without a fresh client', async () => {
    const result = await evaluateDiscoveryGates(
      projectRoot,
      config,
      new Date('2026-04-29T00:00:00.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'no_fresh_heartbeat' })
  })

  test('blocks when an agent is busy', async () => {
    await writeBeat({ agentBusy: true })

    const result = await evaluateDiscoveryGates(
      projectRoot,
      config,
      new Date('2026-04-29T00:00:30.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'agent_busy' })
  })

  test('blocks after a recent user message', async () => {
    await writeBeat({
      writtenAt: '2026-04-29T00:08:00.000Z',
      lastUserMsgAt: '2026-04-29T00:04:00.000Z',
    })

    const result = await evaluateDiscoveryGates(
      projectRoot,
      config,
      new Date('2026-04-29T00:08:00.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'recent_user_msg' })
  })

  test('blocks while the project is in cooldown', async () => {
    await writeBeat({ writtenAt: '2026-04-29T00:30:00.000Z' })
    await writeState({ lastFireCompletedAt: '2026-04-29T00:00:00.000Z' })

    const result = await evaluateDiscoveryGates(
      projectRoot,
      config,
      new Date('2026-04-29T00:30:00.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'cooldown' })
  })

  test('blocks after the daily budget is exhausted', async () => {
    await writeBeat({ writtenAt: '2026-04-29T00:30:00.000Z' })
    await writeState({ todayRunCount: config.dailyBudget })

    const result = await evaluateDiscoveryGates(
      projectRoot,
      config,
      new Date('2026-04-29T00:30:00.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'daily_budget' })
  })

  test('blocks when another scheduler owns the discovery lock', async () => {
    await writeBeat({ writtenAt: '2026-04-29T00:30:00.000Z' })
    expect(await acquireDiscoveryLock(projectRoot)).toBe(true)

    const result = await evaluateDiscoveryGates(
      projectRoot,
      config,
      new Date('2026-04-29T00:30:00.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'lock_busy' })
    await releaseDiscoveryLock(projectRoot)
  })

  test('passes an idle fresh heartbeat without focused state', async () => {
    await writeBeat()

    const result = await evaluateDiscoveryGates(
      projectRoot,
      config,
      new Date('2026-04-29T00:00:30.000Z'),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.heartbeat.writerId).toBe('webui')
    }
    await releaseDiscoveryLock(projectRoot)
  })

  test('prefers the configured client kind when multiple clients are idle', async () => {
    await writeBeat({
      writerKind: 'webui',
      writerId: 'webui',
      writtenAt: '2026-04-29T00:00:30.000Z',
    })
    await writeBeat({
      writerKind: 'tui',
      writerId: 'tui',
      writtenAt: '2026-04-29T00:00:00.000Z',
    })

    const result = await evaluateDiscoveryGates(
      projectRoot,
      { ...config, preferClient: 'tui' },
      new Date('2026-04-29T00:00:30.000Z'),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.heartbeat.writerId).toBe('tui')
    }
    await releaseDiscoveryLock(projectRoot)
  })
})
