import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  markDiscoveryFireCompleted,
  markDiscoveryFireStarted,
  readDiscoveryState,
} from './state.js'

describe('Always-On discovery state', () => {
  test('persists started and completed state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ao-state-'))
    try {
      const initial = await readDiscoveryState(root)
      expect(initial.todayRunCount).toBe(0)

      const started = await markDiscoveryFireStarted(root)
      expect(started.lastFireStartedAt).toBeTruthy()

      const completed = await markDiscoveryFireCompleted(root, 'started')
      expect(completed.lastFireResult).toBe('started')
      expect(completed.todayRunCount).toBe(1)

      const reread = await readDiscoveryState(root)
      expect(reread.lastFireResult).toBe('started')
      expect(reread.todayRunCount).toBe(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
