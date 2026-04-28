import memoize from 'lodash-es/memoize.js'

export const initializeDatadog = memoize(async (): Promise<boolean> => {
  return false
})

/**
 * Flush remaining Datadog logs and shut down.
 * Called from gracefulShutdown() before process.exit() since
 * forceExit() prevents the beforeExit handler from firing.
 */
export async function shutdownDatadog(): Promise<void> {}

// NOTE: use via src/services/analytics/index.ts > logEvent
export async function trackDatadogEvent(
  _eventName: string,
  _properties: { [key: string]: boolean | number | undefined },
): Promise<void> {}
