import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearCronDaemonOwner,
  CRON_DAEMON_OWNER_KIND_ENV,
  CRON_DAEMON_OWNER_PROCESS_PID_ENV,
  CRON_DAEMON_OWNER_TOKEN_ENV,
  persistRequestedCronDaemonOwner,
  reconcileCronDaemonOwnerForCurrentProcess,
  readCronDaemonOwner,
} from './ownership.js'

describe('cron daemon ownership', () => {
  let tempDir: string | null = null

  afterEach(async () => {
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env[CRON_DAEMON_OWNER_KIND_ENV]
    delete process.env[CRON_DAEMON_OWNER_TOKEN_ENV]
    delete process.env[CRON_DAEMON_OWNER_PROCESS_PID_ENV]
    await clearCronDaemonOwner()
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  test('persists owner metadata from environment and clears it', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cron-daemon-owner-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
    process.env[CRON_DAEMON_OWNER_KIND_ENV] = 'claudecodeui-server'
    process.env[CRON_DAEMON_OWNER_TOKEN_ENV] = 'owner-token'
    process.env[CRON_DAEMON_OWNER_PROCESS_PID_ENV] = '12345'

    await persistRequestedCronDaemonOwner()

    const owner = await readCronDaemonOwner()
    expect(owner).toMatchObject({
      kind: 'claudecodeui-server',
      token: 'owner-token',
      processId: 12345,
    })

    const raw = await readFile(join(tempDir, 'cron-daemon', 'owner.json'), 'utf-8')
    expect(raw).toContain('"owner-token"')

    await clearCronDaemonOwner()
    expect(await readCronDaemonOwner()).toBeNull()
  })

  test('clears owner metadata when a different client connects', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cron-daemon-owner-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
    process.env[CRON_DAEMON_OWNER_KIND_ENV] = 'claudecodeui-server'
    process.env[CRON_DAEMON_OWNER_TOKEN_ENV] = 'first-owner'

    await persistRequestedCronDaemonOwner()
    process.env[CRON_DAEMON_OWNER_TOKEN_ENV] = 'second-owner'

    await reconcileCronDaemonOwnerForCurrentProcess()
    expect(await readCronDaemonOwner()).toBeNull()
  })

  test('keeps owner metadata when a client has no owner environment', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cron-daemon-owner-'))
    process.env.CLAUDE_CONFIG_DIR = tempDir
    process.env[CRON_DAEMON_OWNER_KIND_ENV] = 'claudecodeui-server'
    process.env[CRON_DAEMON_OWNER_TOKEN_ENV] = 'ui-owner'

    await persistRequestedCronDaemonOwner()
    delete process.env[CRON_DAEMON_OWNER_KIND_ENV]
    delete process.env[CRON_DAEMON_OWNER_TOKEN_ENV]

    await reconcileCronDaemonOwnerForCurrentProcess()
    expect(await readCronDaemonOwner()).toMatchObject({
      kind: 'claudecodeui-server',
      token: 'ui-owner',
    })
  })
})
