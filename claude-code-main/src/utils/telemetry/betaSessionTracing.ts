import type { Span } from '@opentelemetry/api'

export function clearBetaTracingState(): void {}

export function isBetaTracingEnabled(): boolean {
  return false
}

export function truncateContent(
  content: string,
  _maxSize?: number,
): { content: string; truncated: boolean } {
  return { content, truncated: false }
}

export interface LLMRequestNewContext {
  systemPrompt?: string
  querySource?: string
  tools?: string
}

export function addBetaInteractionAttributes(
  _span: Span,
  _userPrompt: string,
): void {}

export function addBetaLLMRequestAttributes(
  _span: Span,
  _newContext?: LLMRequestNewContext,
  _messagesForAPI?: unknown[],
): void {}

export function addBetaLLMResponseAttributes(
  _endAttributes: Record<string, string | number | boolean>,
  _metadata?: {
    modelOutput?: string
    thinkingOutput?: string
  },
): void {}

export function addBetaToolInputAttributes(
  _span: Span,
  _toolName: string,
  _toolInput: string,
): void {}

export function addBetaToolResultAttributes(
  _endAttributes: Record<string, string | number | boolean>,
  _toolName: string | number | boolean,
  _toolResult: string,
): void {}
