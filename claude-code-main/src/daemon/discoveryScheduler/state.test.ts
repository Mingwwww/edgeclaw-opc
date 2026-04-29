import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  markDiscoveryFireComplete,
  markDiscoveryFireStarted,
  readDiscoveryState,
} from './state.js'
import { getAlwaysOnDiscoveryStatePath } from '../../utils/alwaysOnPaths.js'

describe('always-on discovery state', () => {
  test('persists started and failed state', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'always-on-state-'))

    await markDiscoveryFireStarted(
      projectRoot,
      new Date('2026-04-29T00:00:00.000Z'),
    )
    await markDiscoveryFireComplete(
      projectRoot,
      'failed',
      new Date('2026-04-29T00:01:00.000Z'),
    )

    const state = await readDiscoveryState(
      projectRoot,
      new Date('2026-04-29T00:02:00.000Z'),
    )
    expect(state.todayRunCount).toBe(1)
    expect(state.consecutiveFailures).toBe(1)
    expect(state.lastFireStartedAt).toBe('2026-04-29T00:00:00.000Z')
    expect(state.lastFireCompletedAt).toBe('2026-04-29T00:01:00.000Z')
  })

  test('resets daily run count on a new day', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'always-on-state-day-'))
    await markDiscoveryFireStarted(
      projectRoot,
      new Date('2026-04-29T00:00:00.000Z'),
    )

    const state = await readDiscoveryState(
      projectRoot,
      new Date('2026-04-30T00:00:00.000Z'),
    )

    expect(state.todayKey).toBe('2026-04-30')
    expect(state.todayRunCount).toBe(0)
  })

  test('normalizes invalid persisted state back to defaults', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'always-on-state-invalid-'))
    const statePath = getAlwaysOnDiscoveryStatePath(projectRoot)
    await mkdir(dirname(statePath), { recursive: true })
    await writeFile(
      statePath,
      JSON.stringify({
        schemaVersion: 2,
        todayRunCount: 99,
        consecutiveFailures: 99,
      }),
    )

    const state = await readDiscoveryState(
      projectRoot,
      new Date('2026-04-29T00:00:00.000Z'),
    )

    expect(state).toEqual({
      schemaVersion: 1,
      todayKey: '2026-04-29',
      todayRunCount: 0,
      consecutiveFailures: 0,
    })
  })

  test('successful completion resets consecutive failures', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'always-on-state-success-'))
    await markDiscoveryFireStarted(
      projectRoot,
      new Date('2026-04-29T00:00:00.000Z'),
    )
    await markDiscoveryFireComplete(
      projectRoot,
      'failed',
      new Date('2026-04-29T00:01:00.000Z'),
    )
    await markDiscoveryFireComplete(
      projectRoot,
      'completed',
      new Date('2026-04-29T00:02:00.000Z'),
    )

    const state = await readDiscoveryState(
      projectRoot,
      new Date('2026-04-29T00:03:00.000Z'),
    )

    expect(state.consecutiveFailures).toBe(0)
    expect(state.lastFireCompletedAt).toBe('2026-04-29T00:02:00.000Z')
  })
})
