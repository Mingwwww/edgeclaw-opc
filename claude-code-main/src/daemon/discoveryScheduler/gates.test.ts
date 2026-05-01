import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { evaluateDiscoveryGates } from './gates.js'
import { DEFAULT_DISCOVERY_TRIGGER_CONFIG } from './config.js'
import { releaseDiscoveryLock } from './lock.js'
import { getAlwaysOnHeartbeatsDir, getAlwaysOnHeartbeatPath } from '../../utils/alwaysOnPaths.js'

function configFor(projectRoot: string) {
  return {
    ...DEFAULT_DISCOVERY_TRIGGER_CONFIG,
    enabled: true,
    cooldownMinutes: 60,
    dailyBudget: 4,
    heartbeatStaleSeconds: 90,
    recentUserMsgMinutes: 5,
    projectSettings: {
      [projectRoot]: { enabled: true },
    },
  }
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

  test('blocks without a fresh client', async () => {
    const result = await evaluateDiscoveryGates(
      projectRoot,
      configFor(projectRoot),
      new Date('2026-04-29T00:00:00.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'no_fresh_heartbeat' })
  })

  test('blocks when the project is not opted in', async () => {
    await writeBeat({
      writtenAt: '2026-04-29T00:00:00.000Z',
    })

    const result = await evaluateDiscoveryGates(
      projectRoot,
      {
        ...configFor(projectRoot),
        projectSettings: {},
      },
      new Date('2026-04-29T00:00:30.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'project_disabled' })
  })

  test('blocks when an agent is busy', async () => {
    await writeBeat({ agentBusy: true })

    const result = await evaluateDiscoveryGates(
      projectRoot,
      configFor(projectRoot),
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
      configFor(projectRoot),
      new Date('2026-04-29T00:08:00.000Z'),
    )

    expect(result).toEqual({ ok: false, reason: 'recent_user_msg' })
  })

  test('passes an idle fresh heartbeat without focused state', async () => {
    await writeBeat()

    const result = await evaluateDiscoveryGates(
      projectRoot,
      configFor(projectRoot),
      new Date('2026-04-29T00:00:30.000Z'),
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.heartbeat.writerId).toBe('webui')
    }
    await releaseDiscoveryLock(projectRoot)
  })
})
