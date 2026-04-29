import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { notifyDiscoveryFire } from './notifier.js'
import { readDiscoveryState } from './state.js'

const heartbeat = {
  schemaVersion: 1 as const,
  writerKind: 'webui' as const,
  writerId: 'webui-1',
  writtenAt: '2026-04-29T00:00:00.000Z',
  agentBusy: false,
  processingSessionIds: [],
  lastUserMsgAt: null,
}

describe('notifyDiscoveryFire', () => {
  let projectRoot: string
  let configDir: string
  const priorConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'always-on-notifier-project-'))
    configDir = await mkdtemp(join(tmpdir(), 'always-on-notifier-config-'))
    process.env.CLAUDE_CONFIG_DIR = configDir
  })

  afterEach(async () => {
    if (priorConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = priorConfigDir
    }
    await rm(projectRoot, { recursive: true, force: true })
    await rm(configDir, { recursive: true, force: true })
  })

  test('writes a discovery fire request and marks the project as started', async () => {
    await notifyDiscoveryFire(
      projectRoot,
      heartbeat,
      new Date('2026-04-29T00:00:00.000Z'),
    )

    const requestsDir = join(configDir, 'cron-daemon', 'discovery-requests')
    const entries = await readdir(requestsDir)
    expect(entries).toHaveLength(1)

    const request = JSON.parse(await readFile(join(requestsDir, entries[0]!), 'utf-8'))
    expect(request).toMatchObject({
      schemaVersion: 1,
      projectRoot,
      targetWriterKind: 'webui',
      targetWriterId: 'webui-1',
      createdAt: '2026-04-29T00:00:00.000Z',
    })
    expect(typeof request.requestId).toBe('string')

    const state = await readDiscoveryState(
      projectRoot,
      new Date('2026-04-29T00:00:00.000Z'),
    )
    expect(state.todayRunCount).toBe(1)
    expect(state.lastFireStartedAt).toBe('2026-04-29T00:00:00.000Z')
  })
})
