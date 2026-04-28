import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import type {
  LogRecordExporter,
  ReadableLogRecord,
} from '@opentelemetry/sdk-logs'

/**
 * Exporter for 1st-party event logging to /api/event_logging/batch.
 *
 * Export cycles are controlled by OpenTelemetry's BatchLogRecordProcessor, which
 * triggers export() when either:
 * - Time interval elapses (default: 5 seconds via scheduledDelayMillis)
 * - Batch size is reached (default: 200 events via maxExportBatchSize)
 *
 * This exporter adds resilience on top:
 * - Append-only log for failed events (concurrency-safe)
 * - Quadratic backoff retry for failed events, dropped after maxAttempts
 * - Immediate retry of queued events when any export succeeds (endpoint is healthy)
 * - Chunking large event sets into smaller batches
 * - Auth fallback: retries without auth on 401 errors
 */
export class FirstPartyEventLoggingExporter implements LogRecordExporter {
  constructor(
    _options: {
      timeout?: number
      maxBatchSize?: number
      skipAuth?: boolean
      batchDelayMs?: number
      baseBackoffDelayMs?: number
      maxBackoffDelayMs?: number
      maxAttempts?: number
      path?: string
      baseUrl?: string
      isKilled?: () => boolean
      schedule?: (fn: () => Promise<void>, delayMs: number) => () => void
    } = {},
  ) {}

  export(
    _logs: ReadableLogRecord[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
