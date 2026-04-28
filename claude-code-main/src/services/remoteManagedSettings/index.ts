/**
 * Remote Managed Settings Service (stubbed)
 */

import type { SettingsJson } from '../../utils/settings/types.js'

export function initializeRemoteManagedSettingsLoadingPromise(): void {}

export function computeChecksumFromSettings(_settings: SettingsJson): string {
  return ''
}

export function isEligibleForRemoteManagedSettings(): boolean {
  return false
}

export async function waitForRemoteManagedSettingsToLoad(): Promise<void> {
  return Promise.resolve()
}

export async function clearRemoteManagedSettingsCache(): Promise<void> {
  return Promise.resolve()
}

export async function loadRemoteManagedSettings(): Promise<void> {
  return Promise.resolve()
}

export async function refreshRemoteManagedSettings(): Promise<void> {
  return Promise.resolve()
}

export function startBackgroundPolling(): void {}

export function stopBackgroundPolling(): void {}
