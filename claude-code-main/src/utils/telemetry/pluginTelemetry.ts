/**
 * Plugin telemetry helpers — shared field builders for plugin lifecycle events.
 *
 * Stubbed: logic disabled; types and signatures preserved for callers.
 */

import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import type {
  LoadedPlugin,
  PluginError,
  PluginManifest,
} from '../../types/plugin.js'

const BUILTIN_MARKETPLACE_NAME = 'builtin'

export function hashPluginId(_name: string, _marketplace?: string): string {
  return ''
}

export type TelemetryPluginScope =
  | 'official'
  | 'org'
  | 'user-local'
  | 'default-bundle'

export function getTelemetryPluginScope(
  _name: string,
  marketplace: string | undefined,
  _managedNames: Set<string> | null,
): TelemetryPluginScope {
  if (marketplace === BUILTIN_MARKETPLACE_NAME) return 'default-bundle'
  return 'user-local'
}

export type EnabledVia =
  | 'user-install'
  | 'org-policy'
  | 'default-enable'
  | 'seed-mount'

export type InvocationTrigger =
  | 'user-slash'
  | 'claude-proactive'
  | 'nested-skill'

export type SkillExecutionContext = 'fork' | 'inline' | 'remote'

export type InstallSource =
  | 'cli-explicit'
  | 'ui-discover'
  | 'ui-suggestion'
  | 'deep-link'

export function getEnabledVia(
  plugin: LoadedPlugin,
  managedNames: Set<string> | null,
  _seedDirs: string[],
): EnabledVia {
  if (plugin.isBuiltin) return 'default-enable'
  if (managedNames?.has(plugin.name)) return 'org-policy'
  return 'user-install'
}

export function buildPluginTelemetryFields(
  _name: string,
  _marketplace: string | undefined,
  _managedNames: Set<string> | null = null,
): {
  plugin_id_hash: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  plugin_scope: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  plugin_name_redacted: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  marketplace_name_redacted: AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  is_official_plugin: boolean
} {
  return {
    plugin_id_hash:
      '' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    plugin_scope:
      'user-local' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    plugin_name_redacted:
      'third-party' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    marketplace_name_redacted:
      'third-party' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    is_official_plugin: false,
  }
}

export function buildPluginCommandTelemetryFields(
  pluginInfo: { pluginManifest: PluginManifest; repository: string },
  managedNames: Set<string> | null = null,
): ReturnType<typeof buildPluginTelemetryFields> {
  return buildPluginTelemetryFields(
    pluginInfo.pluginManifest.name,
    undefined,
    managedNames,
  )
}

export function logPluginsEnabledForSession(
  _plugins: LoadedPlugin[],
  _managedNames: Set<string> | null,
  _seedDirs: string[],
): void {}

export type PluginCommandErrorCategory =
  | 'network'
  | 'not-found'
  | 'permission'
  | 'validation'
  | 'unknown'

export function classifyPluginCommandError(
  _error: unknown,
): PluginCommandErrorCategory {
  return 'unknown'
}

export function logPluginLoadErrors(
  _errors: PluginError[],
  _managedNames: Set<string> | null,
): void {}
