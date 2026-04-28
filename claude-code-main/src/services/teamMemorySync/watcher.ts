/**
 * Team Memory File Watcher (stubbed)
 */

import type { SyncState } from './index.js'
import type { TeamMemorySyncPushResult } from './types.js'

export function isPermanentFailure(_r: TeamMemorySyncPushResult): boolean {
  return false
}

export async function startTeamMemoryWatcher(): Promise<void> {
  return Promise.resolve()
}

export async function notifyTeamMemoryWrite(): Promise<void> {
  return Promise.resolve()
}

export async function stopTeamMemoryWatcher(): Promise<void> {
  return Promise.resolve()
}

export function _resetWatcherStateForTesting(_opts?: {
  syncState?: SyncState
  skipWatcher?: boolean
  pushSuppressedReason?: string | null
}): void {}

export function _startFileWatcherForTesting(_dir: string): Promise<void> {
  return Promise.resolve()
}
