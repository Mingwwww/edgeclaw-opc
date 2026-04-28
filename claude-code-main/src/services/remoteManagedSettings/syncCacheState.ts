/**
 * Leaf state module for the remote-managed-settings sync cache (stubbed).
 */

import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import type { SettingsJson } from '../../utils/settings/types.js'

const SETTINGS_FILENAME = 'remote-settings.json'

export function setSessionCache(_value: SettingsJson | null): void {}

export function resetSyncCache(): void {}

export function setEligibility(v: boolean): boolean {
  return v
}

export function getSettingsPath(): string {
  return join(getClaudeConfigHomeDir(), SETTINGS_FILENAME)
}

export function getRemoteManagedSettingsSyncFromCache(): SettingsJson | null {
  return null
}
