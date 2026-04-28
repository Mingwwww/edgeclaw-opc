import type { GrowthBookUserAttributes } from './growthbook.js'

/**
 * Configuration for sampling individual event types.
 * Each event name maps to an object containing sample_rate (0-1).
 * Events not in the config are logged at 100% rate.
 */
export type EventSamplingConfig = {
  [eventName: string]: {
    sample_rate: number
  }
}

/**
 * Get the event sampling configuration from GrowthBook.
 * Uses cached value if available, updates cache in background.
 */
export function getEventSamplingConfig(): EventSamplingConfig {
  return {}
}

/**
 * Determine if an event should be sampled based on its sample rate.
 * Returns the sample rate if sampled, null if not sampled.
 *
 * @param eventName - Name of the event to check
 * @returns The sample_rate if event should be logged, null if it should be dropped
 */
export function shouldSampleEvent(_eventName: string): number | null {
  return null
}

/**
 * Flush and shutdown the 1P event logger.
 * This should be called as the final step before process exit to ensure
 * all events (including late ones from API responses) are exported.
 */
export async function shutdown1PEventLogging(): Promise<void> {}

/**
 * Check if 1P event logging is enabled.
 * Respects the same opt-outs as other analytics sinks:
 * - Test environment
 * - Third-party cloud providers (Bedrock/Vertex)
 * - Global telemetry opt-outs
 * - Non-essential traffic disabled
 *
 * Note: Unlike BigQuery metrics, event logging does NOT check organization-level
 * metrics opt-out via API. It follows the same pattern as Statsig event logging.
 */
export function is1PEventLoggingEnabled(): boolean {
  return false
}

/**
 * Log a 1st-party event for internal analytics.
 * Events are batched and exported to /api/event_logging/batch
 *
 * @param eventName - Name of the event (e.g., 'tengu_api_query')
 * @param metadata - Additional metadata for the event (intentionally no strings, to avoid accidentally logging code/filepaths)
 */
export function logEventTo1P(
  _eventName: string,
  _metadata: Record<string, number | boolean | undefined> = {},
): void {}

/**
 * GrowthBook experiment event data for logging
 */
export type GrowthBookExperimentData = {
  experimentId: string
  variationId: number
  userAttributes?: GrowthBookUserAttributes
  experimentMetadata?: Record<string, unknown>
}

/**
 * Log a GrowthBook experiment assignment event to 1P.
 * Events are batched and exported to /api/event_logging/batch
 *
 * @param data - GrowthBook experiment assignment data
 */
export function logGrowthBookExperimentTo1P(_data: GrowthBookExperimentData): void {}

/**
 * Initialize 1P event logging infrastructure.
 * This creates a separate LoggerProvider for internal event logging,
 * independent of customer OTLP telemetry.
 *
 * This uses its own minimal resource configuration with just the attributes
 * we need for internal analytics (service name, version, platform info).
 */
export function initialize1PEventLogging(): void {}

/**
 * Rebuild the 1P event logging pipeline if the batch config changed.
 * Register this with onGrowthBookRefresh so long-running sessions pick up
 * changes to batch size, delay, endpoint, etc.
 *
 * Event-loss safety:
 * 1. Null the logger first — concurrent logEventTo1P() calls hit the
 *    !firstPartyEventLogger guard and bail during the swap window. This drops
 *    a handful of events but prevents emitting to a draining provider.
 * 2. forceFlush() drains the old BatchLogRecordProcessor buffer to the
 *    exporter. Export failures go to disk at getCurrentBatchFilePath() which
 *    is keyed by module-level BATCH_UUID + sessionId — unchanged across
 *    reinit — so the NEW exporter's disk-backed retry picks them up.
 * 3. Swap to new provider/logger; old provider shutdown runs in background
 *    (buffer already drained, just cleanup).
 */
export async function reinitialize1PEventLoggingIfConfigChanged(): Promise<void> {}
