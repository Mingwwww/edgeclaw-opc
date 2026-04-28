import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const requests: any[] = []
const cleanupFns: Array<() => Promise<void>> = []
let pingFailures = 0
let spawnCalls = 0

mock.module('./ipc.js', () => ({
  assertCronDaemonOk: (response: any) => {
    if (!response?.ok) {
      throw new Error(response?.error ?? 'not ok')
    }
  },
  sendCronDaemonRequest: async (request: any) => {
    requests.push(request)
    if (request.type === 'ping' && pingFailures > 0) {
      pingFailures -= 1
      const error: NodeJS.ErrnoException = new Error('missing daemon')
      error.code = 'ENOENT'
      throw error
    }
    switch (request.type) {
      case 'ping':
        return { ok: true, data: { type: 'pong', runtimes: [] } }
      case 'register_client':
        return {
          ok: true,
          data: {
            type: 'register_client',
            registered: true,
            leaseExpiresAt: Date.now() + 30_000,
          },
        }
      case 'heartbeat_client':
        return {
          ok: true,
          data: {
            type: 'heartbeat_client',
            accepted: true,
            leaseExpiresAt: Date.now() + 30_000,
          },
        }
      case 'unregister_client':
        return {
          ok: true,
          data: { type: 'unregister_client', remainingClients: 0 },
        }
      default:
        return { ok: true, data: { type: request.type } }
    }
  },
}))

mock.module('./ownership.js', () => ({
  persistRequestedCronDaemonOwner: async () => {},
  reconcileCronDaemonOwnerForCurrentProcess: async () => {},
}))

mock.module('child_process', () => ({
  spawn: () => {
    spawnCalls += 1
    return { unref() {} }
  },
}))

mock.module('../utils/cleanupRegistry.js', () => ({
  registerCleanup: (fn: () => Promise<void>) => {
    cleanupFns.push(fn)
    return () => {
      const index = cleanupFns.indexOf(fn)
      if (index !== -1) cleanupFns.splice(index, 1)
    }
  },
}))

const { ensureCronDaemon, _resetCronDaemonClientForTest } = await import(
  './client.js'
)

describe('cron daemon TUI client lease', () => {
  beforeEach(() => {
    requests.length = 0
    cleanupFns.length = 0
    pingFailures = 0
    spawnCalls = 0
    _resetCronDaemonClientForTest()
  })

  afterEach(() => {
    _resetCronDaemonClientForTest()
  })

  test('registers a TUI lease when reusing an existing daemon', async () => {
    await ensureCronDaemon()

    expect(spawnCalls).toBe(0)
    expect(requests.map(request => request.type)).toEqual([
      'ping',
      'register_client',
    ])
    expect(requests[1]).toMatchObject({
      type: 'register_client',
      clientType: 'tui',
      processId: process.pid,
    })
    expect(cleanupFns.length).toBe(1)
  })

  test('starts the daemon and then registers a TUI lease', async () => {
    pingFailures = 1

    await ensureCronDaemon()

    expect(spawnCalls).toBe(1)
    expect(requests.map(request => request.type)).toEqual([
      'ping',
      'ping',
      'register_client',
    ])
  })

  test('does not register duplicate leases in the same TUI process', async () => {
    await ensureCronDaemon()
    await ensureCronDaemon()

    expect(requests.map(request => request.type)).toEqual([
      'ping',
      'register_client',
      'ping',
    ])
    expect(cleanupFns.length).toBe(1)
  })

  test('cleanup unregisters the TUI lease', async () => {
    await ensureCronDaemon()
    await cleanupFns[0]?.()

    expect(requests.at(-1)?.type).toBe('unregister_client')
  })
})
