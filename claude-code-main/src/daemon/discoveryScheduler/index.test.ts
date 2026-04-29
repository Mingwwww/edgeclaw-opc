import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { DiscoveryScheduler } from './index.js'

const heartbeat = {
  schemaVersion: 1 as const,
  writerKind: 'webui' as const,
  writerId: 'webui-1',
  writtenAt: '2026-04-29T00:00:00.000Z',
  agentBusy: false,
  processingSessionIds: [],
  lastUserMsgAt: null,
}

const config = {
  enabled: true,
  tickIntervalMinutes: 60,
  cooldownMinutes: 60,
  dailyBudget: 4,
  heartbeatStaleSeconds: 90,
  recentUserMsgMinutes: 5,
  preferClient: 'webui' as const,
}

const getDiscoveryTriggerConfigMock = mock(() => config)
const evaluateDiscoveryGatesMock = mock(async () => ({ ok: true as const, heartbeat }))
const notifyDiscoveryFireMock = mock(async () => {})

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
  }
  throw new Error('Timed out waiting for condition')
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

describe('DiscoveryScheduler', () => {
  let projectRoot: string
  const deps = {
    getDiscoveryTriggerConfig: getDiscoveryTriggerConfigMock,
    evaluateDiscoveryGates: evaluateDiscoveryGatesMock,
    notifyDiscoveryFire: notifyDiscoveryFireMock,
  }

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'always-on-scheduler-'))
    getDiscoveryTriggerConfigMock.mockClear()
    evaluateDiscoveryGatesMock.mockReset()
    evaluateDiscoveryGatesMock.mockImplementation(async () => ({
      ok: true as const,
      heartbeat,
    }))
    notifyDiscoveryFireMock.mockReset()
    notifyDiscoveryFireMock.mockImplementation(async () => {})
  })

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true })
  })

  test('ticks a project immediately and notifies when gates pass', async () => {
    const scheduler = new DiscoveryScheduler(deps)

    scheduler.ensureProject(projectRoot)
    await waitForCondition(() => notifyDiscoveryFireMock.mock.calls.length === 1)
    scheduler.stop()

    expect(evaluateDiscoveryGatesMock).toHaveBeenCalledWith(resolve(projectRoot), config)
    expect(notifyDiscoveryFireMock).toHaveBeenCalledWith(resolve(projectRoot), heartbeat)
  })

  test('does not notify after stop while gate evaluation is in flight', async () => {
    const gate = deferred<{ ok: true; heartbeat: typeof heartbeat }>()
    evaluateDiscoveryGatesMock.mockImplementationOnce(async () => await gate.promise)
    const scheduler = new DiscoveryScheduler(deps)

    scheduler.ensureProject(projectRoot)
    await waitForCondition(() => evaluateDiscoveryGatesMock.mock.calls.length === 1)

    scheduler.stop()
    gate.resolve({ ok: true, heartbeat })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))

    expect(notifyDiscoveryFireMock).not.toHaveBeenCalled()
  })
})
