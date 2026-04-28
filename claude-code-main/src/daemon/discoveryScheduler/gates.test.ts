import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAlwaysOnHeartbeatPath } from '../../utils/alwaysOnPaths.js'
import { releaseDiscoveryLock } from './lock.js'
import { evaluateDiscoveryGates } from './gates.js'
import type { AlwaysOnDiscoveryTriggerConfig } from './types.js'

const CONFIG: AlwaysOnDiscoveryTriggerConfig = {
  enabled: true,
  tickIntervalMinutes: 5,
  cooldownMinutes: 60,
  dailyBudget: 4,
  heartbeatStaleSeconds: 90,
  recentUserMsgMinutes: 5,
  preferClient: 'webui',
}

async function writeHeartbeat(
  root: string,
  body: {
    agentBusy?: boolean
    lastUserMsgAt?: string
  } = {},
) {
  await mkdir(join(root, '.claude', 'always-on', 'heartbeats'), { recursive: true })
  await writeFile(
    getAlwaysOnHeartbeatPath(root, 'webui-test.beat'),
    JSON.stringify({
      schemaVersion: 1,
      writerKind: 'webui',
      writerId: 'test',
      writtenAt: new Date().toISOString(),
      processingSessionIds: [],
      ...body,
    }),
  )
}

describe('Always-On discovery gates', () => {
  test('blocks busy heartbeats', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ao-gates-busy-'))
    try {
      await writeHeartbeat(root, { agentBusy: true })
      const result = await evaluateDiscoveryGates(root, CONFIG)
      expect(result).toEqual({ fire: false, blockedAt: 1, reason: 'agent_busy' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('blocks recent user messages', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ao-gates-recent-'))
    try {
      await writeHeartbeat(root, { lastUserMsgAt: new Date().toISOString() })
      const result = await evaluateDiscoveryGates(root, CONFIG)
      expect(result).toEqual({
        fire: false,
        blockedAt: 1,
        reason: 'recent_user_msg',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('allows fresh idle heartbeat through gate 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ao-gates-idle-'))
    try {
      await writeHeartbeat(root)
      const result = await evaluateDiscoveryGates(root, CONFIG)
      expect(result.fire).toBe(true)
      if (result.fire) {
        await releaseDiscoveryLock(result.lockHandle)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
