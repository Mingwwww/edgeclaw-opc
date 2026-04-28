import { describe, expect, test } from 'bun:test'
import { ClientLeaseRegistry } from './clientLeases.js'

describe('ClientLeaseRegistry', () => {
  test('registers, heartbeats, and summarizes active clients', () => {
    let now = 1_000
    const registry = new ClientLeaseRegistry({ now: () => now, defaultTtlMs: 100 })

    const lease = registry.register({
      clientId: 'web-ui:1',
      clientType: 'web-ui',
      processId: 1,
    })
    expect(lease.leaseExpiresAt).toBe(1_100)
    expect(registry.summarize()).toEqual({
      total: 1,
      byType: { 'web-ui': 1, tui: 0 },
    })

    now = 1_050
    const heartbeat = registry.heartbeat('web-ui:1')
    expect(heartbeat?.leaseExpiresAt).toBe(1_150)
  })

  test('prunes expired clients and unregisters active clients', () => {
    let now = 1_000
    const registry = new ClientLeaseRegistry({ now: () => now, defaultTtlMs: 100 })

    registry.register({ clientId: 'tui:1', clientType: 'tui' })
    registry.register({ clientId: 'web-ui:1', clientType: 'web-ui' })
    expect(registry.unregister('web-ui:1')).toBe(1)

    now = 1_101
    expect(registry.pruneExpired()).toBe(1)
    expect(registry.hasActiveClients()).toBe(false)
  })

  test('notifies when all clients expire', async () => {
    let now = 1_000
    let emptyCount = 0
    const registry = new ClientLeaseRegistry({
      now: () => now,
      defaultTtlMs: 100,
      pruneIntervalMs: 1_000,
      onEmpty: () => {
        emptyCount += 1
      },
    })

    registry.start()
    registry.register({ clientId: 'tui:1', clientType: 'tui' })
    now = 1_101
    registry.pruneExpired()
    ;(registry as any).notifyEmptyIfNeeded()
    registry.stop()

    expect(emptyCount).toBe(1)
  })
})
