import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { getAlwaysOnHeartbeatsDir } from '../../utils/alwaysOnPaths.js'
import { getErrnoCode } from '../../utils/errors.js'
import { safeParseJSON } from '../../utils/json.js'
import type {
  DiscoveryHeartbeat,
  DiscoveryHeartbeatWriterKind,
  FreshDiscoveryHeartbeat,
} from './types.js'

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined
}

function normalizeSessionIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
    : []
}

export function parseDiscoveryHeartbeat(
  value: unknown,
): DiscoveryHeartbeat | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as Record<string, unknown>
  const writerKind =
    input.writerKind === 'tui' || input.writerKind === 'webui'
      ? (input.writerKind as DiscoveryHeartbeatWriterKind)
      : null
  const writerId = normalizeString(input.writerId)
  const writtenAt = normalizeString(input.writtenAt)
  if (!writerKind || !writerId || !writtenAt) {
    return null
  }

  return {
    schemaVersion: 1,
    writerKind,
    writerId,
    writtenAt,
    ...(typeof input.agentBusy === 'boolean'
      ? { agentBusy: input.agentBusy }
      : {}),
    processingSessionIds: normalizeSessionIds(input.processingSessionIds),
    ...(typeof input.lastUserMsgAt === 'string'
      ? { lastUserMsgAt: input.lastUserMsgAt }
      : {}),
  }
}

export async function readFreshDiscoveryHeartbeats(
  projectRoot: string,
  staleMs: number,
): Promise<FreshDiscoveryHeartbeat[]> {
  const dir = getAlwaysOnHeartbeatsDir(projectRoot)
  let names: string[]
  try {
    names = (await readdir(dir)).filter(name => name.endsWith('.beat'))
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') {
      return []
    }
    throw error
  }

  const now = Date.now()
  const results = await Promise.all(
    names.map(async fileName => {
      const filePath = join(dir, fileName)
      try {
        const [s, raw] = await Promise.all([
          stat(filePath),
          readFile(filePath, 'utf-8'),
        ])
        const ageMs = now - s.mtimeMs
        if (ageMs > staleMs) {
          return null
        }
        const body = parseDiscoveryHeartbeat(safeParseJSON(raw, false))
        if (!body) {
          return null
        }
        return {
          fileName,
          filePath,
          mtimeMs: s.mtimeMs,
          ageMs,
          body,
        }
      } catch {
        return null
      }
    }),
  )

  return results.filter(
    (heartbeat): heartbeat is FreshDiscoveryHeartbeat => heartbeat !== null,
  )
}

export function hasBusyHeartbeat(
  heartbeats: readonly FreshDiscoveryHeartbeat[],
): boolean {
  return heartbeats.some(heartbeat => heartbeat.body.agentBusy === true)
}

export function hasRecentUserMessage(
  heartbeats: readonly FreshDiscoveryHeartbeat[],
  recentUserMsgMs: number,
): boolean {
  const now = Date.now()
  return heartbeats.some(heartbeat => {
    if (!heartbeat.body.lastUserMsgAt) {
      return false
    }
    const timestamp = new Date(heartbeat.body.lastUserMsgAt).getTime()
    return Number.isFinite(timestamp) && now - timestamp < recentUserMsgMs
  })
}
