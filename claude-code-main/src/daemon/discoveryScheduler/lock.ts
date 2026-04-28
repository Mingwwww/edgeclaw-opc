import { randomUUID } from 'crypto'
import { mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { getAlwaysOnDiscoveryLockPath } from '../../utils/alwaysOnPaths.js'
import { isProcessRunning } from '../../utils/genericProcessUtils.js'
import { safeParseJSON } from '../../utils/json.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { DiscoveryLockHandle } from './types.js'

const HOLDER_STALE_MS = 30 * 60 * 1000

type LockBody = {
  pid?: number
  requestId?: string
  createdAt?: string
}

function parseLockBody(raw: string): LockBody {
  const parsed = safeParseJSON(raw, false)
  if (!parsed || typeof parsed !== 'object') {
    const legacyPid = parseInt(raw.trim(), 10)
    return Number.isFinite(legacyPid) ? { pid: legacyPid } : {}
  }
  const input = parsed as Partial<LockBody>
  return {
    ...(typeof input.pid === 'number' ? { pid: input.pid } : {}),
    ...(typeof input.requestId === 'string'
      ? { requestId: input.requestId }
      : {}),
    ...(typeof input.createdAt === 'string' ? { createdAt: input.createdAt } : {}),
  }
}

export async function tryAcquireDiscoveryLock(
  projectRoot: string,
): Promise<DiscoveryLockHandle | null> {
  const lockPath = getAlwaysOnDiscoveryLockPath(projectRoot)
  let mtimeMs: number | undefined
  let body: LockBody = {}
  try {
    const [s, raw] = await Promise.all([stat(lockPath), readFile(lockPath, 'utf-8')])
    mtimeMs = s.mtimeMs
    body = parseLockBody(raw)
  } catch {
    // No current lock.
  }

  if (mtimeMs !== undefined && Date.now() - mtimeMs < HOLDER_STALE_MS) {
    if (typeof body.pid === 'number' && isProcessRunning(body.pid)) {
      return null
    }
  }

  const requestId = randomUUID()
  const createdAt = new Date().toISOString()
  await mkdir(dirname(lockPath), { recursive: true })
  await writeFile(
    lockPath,
    jsonStringify({ pid: process.pid, requestId, createdAt }, null, 2) + '\n',
    'utf-8',
  )

  try {
    const verify = parseLockBody(await readFile(lockPath, 'utf-8'))
    if (verify.pid !== process.pid || verify.requestId !== requestId) {
      return null
    }
  } catch {
    return null
  }

  return { projectRoot, lockPath, requestId, createdAt }
}

export async function releaseDiscoveryLock(
  handle: DiscoveryLockHandle,
): Promise<void> {
  try {
    const body = parseLockBody(await readFile(handle.lockPath, 'utf-8'))
    if (body.pid === process.pid && body.requestId === handle.requestId) {
      await unlink(handle.lockPath)
    }
  } catch {
    // Best effort only. Stale lock reclaim handles process crashes.
  }
}
