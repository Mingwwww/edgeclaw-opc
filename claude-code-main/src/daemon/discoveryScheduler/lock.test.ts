import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { releaseDiscoveryLock, tryAcquireDiscoveryLock } from './lock.js'

describe('Always-On discovery lock', () => {
  test('prevents duplicate acquisition for the same project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ao-lock-'))
    try {
      const first = await tryAcquireDiscoveryLock(root)
      expect(first).not.toBeNull()
      const second = await tryAcquireDiscoveryLock(root)
      expect(second).toBeNull()
      if (first) {
        await releaseDiscoveryLock(first)
      }
      const third = await tryAcquireDiscoveryLock(root)
      expect(third).not.toBeNull()
      if (third) {
        await releaseDiscoveryLock(third)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
