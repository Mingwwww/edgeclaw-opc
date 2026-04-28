import { describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAlwaysOnHeartbeatPath } from '../../utils/alwaysOnPaths.js'
import {
  hasBusyHeartbeat,
  hasRecentUserMessage,
  readFreshDiscoveryHeartbeats,
} from './heartbeats.js'

describe('Always-On discovery heartbeats', () => {
  test('reads fresh per-project heartbeats', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ao-heartbeats-'))
    try {
      const path = getAlwaysOnHeartbeatPath(root, 'webui-test.beat')
      await mkdir(join(root, '.claude', 'always-on', 'heartbeats'), { recursive: true })
      await writeFile(
        path,
        JSON.stringify({
          schemaVersion: 1,
          writerKind: 'webui',
          writerId: 'test',
          writtenAt: new Date().toISOString(),
          agentBusy: true,
          processingSessionIds: ['s1', 's2'],
          lastUserMsgAt: new Date().toISOString(),
        }),
      )

      const heartbeats = await readFreshDiscoveryHeartbeats(root, 60_000)
      expect(heartbeats).toHaveLength(1)
      expect(heartbeats[0]?.body.processingSessionIds).toEqual(['s1', 's2'])
      expect(hasBusyHeartbeat(heartbeats)).toBe(true)
      expect(hasRecentUserMessage(heartbeats, 60_000)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
