/**
 * Session tracing — stubbed; exports and types preserved for callers.
 */

import type { Span } from '@opentelemetry/api'
import { trace } from '@opentelemetry/api'
import {
  isBetaTracingEnabled,
  type LLMRequestNewContext,
} from './betaSessionTracing.js'

export type { Span }
export { isBetaTracingEnabled, type LLMRequestNewContext }

function noopSpan(): Span {
  return trace.getTracer('com.anthropic.claude_code.tracing', '1.0.0').startSpan(
    'noop',
  )
}

export function isEnhancedTelemetryEnabled(): boolean {
  return false
}

export function startInteractionSpan(_userPrompt: string): Span {
  return noopSpan()
}

export function endInteractionSpan(): void {}

export function startLLMRequestSpan(
  _model: string,
  _newContext?: LLMRequestNewContext,
  _messagesForAPI?: unknown[],
  _fastMode?: boolean,
): Span {
  return noopSpan()
}

export function endLLMRequestSpan(
  _span?: Span,
  _metadata?: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    success?: boolean
    statusCode?: number
    error?: string
    attempt?: number
    modelResponse?: string
    modelOutput?: string
    thinkingOutput?: string
    hasToolCall?: boolean
    ttftMs?: number
    requestSetupMs?: number
    attemptStartTimes?: number[]
  },
): void {}

export function startToolSpan(
  _toolName: string,
  _toolAttributes?: Record<string, string | number | boolean>,
  _toolInput?: string,
): Span {
  return noopSpan()
}

export function startToolBlockedOnUserSpan(): Span {
  return noopSpan()
}

export function endToolBlockedOnUserSpan(
  _decision?: string,
  _source?: string,
): void {}

export function startToolExecutionSpan(): Span {
  return noopSpan()
}

export function endToolExecutionSpan(
  _metadata?: {
    success?: boolean
    error?: string
  },
): void {}

export function endToolSpan(_toolResult?: string, _resultTokens?: number): void {}

export function addToolContentEvent(
  _eventName: string,
  _attributes: Record<string, string | number | boolean>,
): void {}

export function getCurrentSpan(): Span | undefined {
  return undefined
}

export async function executeInSpan<T>(
  _spanName: string,
  fn: (span: Span) => Promise<T>,
  _attributes?: Record<string, string | number | boolean>,
): Promise<T> {
  return fn(noopSpan())
}

export function startHookSpan(
  _hookEvent: string,
  _hookName: string,
  _numHooks: number,
  _hookDefinitions: string,
): Span {
  return noopSpan()
}

export function endHookSpan(
  _span: Span,
  _metadata?: {
    numSuccess?: number
    numBlocking?: number
    numNonBlockingError?: number
    numCancelled?: number
  },
): void {}
