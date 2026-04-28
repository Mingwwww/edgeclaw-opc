import { randomUUID } from 'crypto'
import { spawn } from 'child_process'
import {
  persistRequestedCronDaemonOwner,
  reconcileCronDaemonOwnerForCurrentProcess,
} from './ownership.js'
import { assertCronDaemonOk, sendCronDaemonRequest } from './ipc.js'
import { getDaemonCommandArgs } from './spawn.js'
import type { CronDaemonRequest, CronDaemonResponse } from './types.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'

const CLIENT_LEASE_TTL_MS = 30_000
const CLIENT_LEASE_HEARTBEAT_MS = 5_000

let tuiClientId: string | null = null
let clientLeaseRegistered = false
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let unregisterCleanup: (() => void) | null = null

function isDaemonUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ('code' in error &&
      (error.code === 'ENOENT' || error.code === 'ECONNREFUSED'))
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function startCronDaemonDetached(): Promise<void> {
  const child = spawn(process.execPath, getDaemonCommandArgs(), {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
}

function getTuiClientId(): string {
  if (!tuiClientId) {
    tuiClientId = `tui:${process.pid}:${randomUUID()}`
  }
  return tuiClientId
}

async function registerTuiClientLease(): Promise<void> {
  if (clientLeaseRegistered) return

  const clientId = getTuiClientId()
  const response = await sendCronDaemonRequest({
    type: 'register_client',
    clientId,
    clientType: 'tui',
    processId: process.pid,
    ttlMs: CLIENT_LEASE_TTL_MS,
  })
  assertCronDaemonOk(response)
  if (response.data.type !== 'register_client') {
    throw new Error('Unexpected Cron daemon client registration response')
  }

  clientLeaseRegistered = true
  heartbeatTimer = setInterval(() => {
    void sendCronDaemonRequest({
      type: 'heartbeat_client',
      clientId,
      ttlMs: CLIENT_LEASE_TTL_MS,
    }).catch(() => {})
  }, CLIENT_LEASE_HEARTBEAT_MS)
  heartbeatTimer.unref?.()

  unregisterCleanup ??= registerCleanup(stopTuiClientLease)
}

async function stopTuiClientLease(): Promise<void> {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  unregisterCleanup?.()
  unregisterCleanup = null

  if (!clientLeaseRegistered || !tuiClientId) {
    return
  }

  const clientId = tuiClientId
  clientLeaseRegistered = false
  tuiClientId = null
  await sendCronDaemonRequest({
    type: 'unregister_client',
    clientId,
  }).catch(() => {})
}

export async function ensureCronDaemon(): Promise<void> {
  let startedByCurrentProcess = false
  try {
    const response = await sendCronDaemonRequest({ type: 'ping' })
    assertCronDaemonOk(response)
    await reconcileCronDaemonOwnerForCurrentProcess()
    await registerTuiClientLease()
    return
  } catch (error) {
    if (!isDaemonUnavailableError(error)) {
      throw error
    }
  }

  await startCronDaemonDetached()
  startedByCurrentProcess = true

  let lastError: unknown = null
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await sendCronDaemonRequest({ type: 'ping' })
      assertCronDaemonOk(response)
      if (startedByCurrentProcess) {
        await persistRequestedCronDaemonOwner()
      }
      await registerTuiClientLease()
      return
    } catch (error) {
      lastError = error
      await sleep(250)
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Cron daemon failed to start')
}

export async function requestCronDaemon(
  request: CronDaemonRequest,
): Promise<CronDaemonResponse> {
  await ensureCronDaemon()
  return await sendCronDaemonRequest(request)
}

export function _resetCronDaemonClientForTest(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  unregisterCleanup?.()
  unregisterCleanup = null
  tuiClientId = null
  clientLeaseRegistered = false
}
