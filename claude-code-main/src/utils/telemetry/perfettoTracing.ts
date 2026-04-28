/**
 * Perfetto tracing — stubbed; exports and types preserved.
 */

export type TraceEventPhase =
  | 'B'
  | 'E'
  | 'X'
  | 'i'
  | 'C'
  | 'b'
  | 'n'
  | 'e'
  | 'M'

export type TraceEvent = {
  name: string
  cat: string
  ph: TraceEventPhase
  ts: number
  pid: number
  tid: number
  dur?: number
  args?: Record<string, unknown>
  id?: string
  scope?: string
}

export function initializePerfettoTracing(): void {}

export function isPerfettoTracingEnabled(): boolean {
  return false
}

export function registerAgent(
  _agentId: string,
  _agentName: string,
  _parentAgentId?: string,
): void {}

export function unregisterAgent(_agentId: string): void {}

export function startLLMRequestPerfettoSpan(_args: {
  model: string
  promptTokens?: number
  messageId?: string
  isSpeculative?: boolean
  querySource?: string
}): string {
  return ''
}

export function endLLMRequestPerfettoSpan(
  _spanId: string,
  _metadata: {
    ttftMs?: number
    ttltMs?: number
    promptTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    messageId?: string
    success?: boolean
    error?: string
    requestSetupMs?: number
    attemptStartTimes?: number[]
  },
): void {}

export function startToolPerfettoSpan(
  _toolName: string,
  _args?: Record<string, unknown>,
): string {
  return ''
}

export function endToolPerfettoSpan(
  _spanId: string,
  _metadata?: {
    success?: boolean
    error?: string
    resultTokens?: number
  },
): void {}

export function startUserInputPerfettoSpan(_context?: string): string {
  return ''
}

export function endUserInputPerfettoSpan(
  _spanId: string,
  _metadata?: {
    decision?: string
    source?: string
  },
): void {}

export function emitPerfettoInstant(
  _name: string,
  _category: string,
  _args?: Record<string, unknown>,
): void {}

export function emitPerfettoCounter(
  _name: string,
  _values: Record<string, number>,
): void {}

export function startInteractionPerfettoSpan(_userPrompt?: string): string {
  return ''
}

export function endInteractionPerfettoSpan(_spanId: string): void {}

export function getPerfettoEvents(): TraceEvent[] {
  return []
}

export function resetPerfettoTracer(): void {}

export async function triggerPeriodicWriteForTesting(): Promise<void> {}

export function evictStaleSpansForTesting(): void {}

export const MAX_EVENTS_FOR_TESTING = 100_000

export function evictOldestEventsForTesting(): void {}
