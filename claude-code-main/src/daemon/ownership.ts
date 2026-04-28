import { mkdir, readFile, unlink, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { getCronDaemonOwnerPath } from './paths.js'
import { safeParseJSON } from '../utils/json.js'
import { jsonStringify } from '../utils/slowOperations.js'

export const CRON_DAEMON_OWNER_KIND_ENV = 'CLOUDCLI_CRON_DAEMON_OWNER_KIND'
export const CRON_DAEMON_OWNER_TOKEN_ENV = 'CLOUDCLI_CRON_DAEMON_OWNER_TOKEN'
export const CRON_DAEMON_OWNER_PROCESS_PID_ENV =
  'CLOUDCLI_CRON_DAEMON_OWNER_PROCESS_PID'

export type CronDaemonOwner = {
  kind: string
  token: string
  processId?: number
  createdAt: number
}

function getRequestedCronDaemonOwnerFromEnv(): CronDaemonOwner | null {
  const kind = process.env[CRON_DAEMON_OWNER_KIND_ENV]?.trim()
  const token = process.env[CRON_DAEMON_OWNER_TOKEN_ENV]?.trim()
  if (!kind || !token) {
    return null
  }

  const rawProcessId =
    process.env[CRON_DAEMON_OWNER_PROCESS_PID_ENV]?.trim() ?? ''
  const parsedProcessId = Number.parseInt(rawProcessId, 10)

  return {
    kind,
    token,
    ...(Number.isInteger(parsedProcessId) ? { processId: parsedProcessId } : {}),
    createdAt: Date.now(),
  }
}

function isSameOwner(
  left: CronDaemonOwner | null,
  right: CronDaemonOwner | null,
): boolean {
  return Boolean(
    left &&
      right &&
      left.kind === right.kind &&
      left.token === right.token,
  )
}

export async function readCronDaemonOwner(): Promise<CronDaemonOwner | null> {
  try {
    const raw = await readFile(getCronDaemonOwnerPath(), 'utf-8')
    const parsed = safeParseJSON(raw, false) as Partial<CronDaemonOwner> | null
    if (
      !parsed ||
      typeof parsed.kind !== 'string' ||
      typeof parsed.token !== 'string' ||
      typeof parsed.createdAt !== 'number'
    ) {
      return null
    }

    return {
      kind: parsed.kind,
      token: parsed.token,
      createdAt: parsed.createdAt,
      ...(typeof parsed.processId === 'number'
        ? { processId: parsed.processId }
        : {}),
    }
  } catch {
    return null
  }
}

export async function writeCronDaemonOwner(
  owner: CronDaemonOwner,
): Promise<void> {
  const path = getCronDaemonOwnerPath()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, jsonStringify(owner, null, 2) + '\n', 'utf-8')
}

export async function persistRequestedCronDaemonOwner(): Promise<void> {
  const owner = getRequestedCronDaemonOwnerFromEnv()
  if (!owner) {
    return
  }

  await writeCronDaemonOwner(owner)
}

export async function clearCronDaemonOwner(): Promise<void> {
  await unlink(getCronDaemonOwnerPath()).catch(() => {})
}

export async function reconcileCronDaemonOwnerForCurrentProcess(): Promise<void> {
  const currentOwner = await readCronDaemonOwner()
  if (!currentOwner) {
    return
  }

  const requestedOwner = getRequestedCronDaemonOwnerFromEnv()
  if (!requestedOwner) {
    return
  }
  if (isSameOwner(currentOwner, requestedOwner)) {
    return
  }

  await clearCronDaemonOwner()
}
