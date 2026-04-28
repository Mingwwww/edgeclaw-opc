/**
 * Team Memory Sync Service (stubbed)
 */

import { createHash } from 'crypto'
import type { TeamMemorySyncPushResult } from './types.js'

export type SyncState = {
  lastKnownChecksum: string | null
  serverChecksums: Map<string, string>
  serverMaxEntries: number | null
}

export function createSyncState(): SyncState {
  return {
    lastKnownChecksum: null,
    serverChecksums: new Map(),
    serverMaxEntries: null,
  }
}

export function hashContent(content: string): string {
  return (
    'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex')
  )
}

export function batchDeltaByBytes(
  delta: Record<string, string>,
): Array<Record<string, string>> {
  const keys = Object.keys(delta).sort()
  if (keys.length === 0) return []
  return [delta]
}

export function isTeamMemorySyncAvailable(): boolean {
  return false
}

export async function pullTeamMemory(
  _state: SyncState,
  _options?: { skipEtagCache?: boolean },
): Promise<{
  success: boolean
  filesWritten: number
  entryCount: number
  notModified?: boolean
  error?: string
}> {
  return Promise.resolve({
    success: true,
    filesWritten: 0,
    entryCount: 0,
  })
}

export async function pushTeamMemory(
  _state: SyncState,
): Promise<TeamMemorySyncPushResult> {
  return Promise.resolve({
    success: true,
    filesUploaded: 0,
  })
}

export async function syncTeamMemory(_state: SyncState): Promise<{
  success: boolean
  filesPulled: number
  filesPushed: number
  error?: string
}> {
  return Promise.resolve({
    success: true,
    filesPulled: 0,
    filesPushed: 0,
  })
}
