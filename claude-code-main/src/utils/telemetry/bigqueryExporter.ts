import type { ExportResult } from '@opentelemetry/core'
import { ExportResultCode } from '@opentelemetry/core'
import {
  AggregationTemporality,
  type ResourceMetrics,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics'

export class BigQueryMetricsExporter implements PushMetricExporter {
  constructor(_options: { timeout?: number } = {}) {}

  async export(
    _metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void,
  ): Promise<void> {
    resultCallback({ code: ExportResultCode.SUCCESS })
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}

  selectAggregationTemporality(): AggregationTemporality {
    return AggregationTemporality.DELTA
  }
}
